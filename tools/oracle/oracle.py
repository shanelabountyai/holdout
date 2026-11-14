"""Holdout analysis oracle (D-03): test-only, never imported by the app.

Recomputes every shared vector with scipy / statsmodels and a pure-Python MurmurHash3, independently of the
TypeScript engine in src/lib/exp/. The TS suite (tests/exp/oracle.test.ts) must agree to 1e-9 (HO-02).

    python tools/oracle/oracle.py          # rewrite tools/oracle/vectors.json and tests/exp/fixtures/assignment-golden.json
    python -m pytest tools/oracle          # fail if either committed file is stale
"""

from __future__ import annotations

import json
import math
import sys
from pathlib import Path

import numpy as np
from scipy import special, stats
from statsmodels.stats.proportion import confint_proportions_2indep, proportions_ztest

ROOT = Path(__file__).resolve().parents[2]
VECTORS = ROOT / "tools" / "oracle" / "vectors.json"
GOLDEN = ROOT / "tests" / "exp" / "fixtures" / "assignment-golden.json"
SEED = 28
MIN_UNITS_PER_ARM = 100  # mirrors src/lib/exp/sequential.ts; diffMeans reports "not enough data" below it (D-15)


# --- assignment -----------------------------------------------------------------------------------------------

def murmur3_32(key: str, seed: int = 0) -> int:
    """MurmurHash3 x86_32 over UTF-8 bytes; written from the reference algorithm, not ported from hash.ts."""
    data = key.encode("utf-8")
    c1, c2, mask = 0xCC9E2D51, 0x1B873593, 0xFFFFFFFF
    h = seed & mask
    n = len(data) // 4
    for i in range(n):
        k = int.from_bytes(data[4 * i : 4 * i + 4], "little")
        k = (k * c1) & mask
        k = ((k << 15) | (k >> 17)) & mask
        k = (k * c2) & mask
        h ^= k
        h = ((h << 13) | (h >> 19)) & mask
        h = (h * 5 + 0xE6546B64) & mask
    tail = data[4 * n :]
    k = 0
    if len(tail) >= 3:
        k ^= tail[2] << 16
    if len(tail) >= 2:
        k ^= tail[1] << 8
    if len(tail) >= 1:
        k ^= tail[0]
        k = (k * c1) & mask
        k = ((k << 15) | (k >> 17)) & mask
        k = (k * c2) & mask
        h ^= k
    h ^= len(data)
    h ^= h >> 16
    h = (h * 0x85EBCA6B) & mask
    h ^= h >> 13
    h = (h * 0xC2B2AE35) & mask
    h ^= h >> 16
    return h


def assign(salt: str, unit: str, variants: list[tuple[str, int]]) -> str:
    b = murmur3_32(f"{salt}:{unit}") % 10_000
    edge = 0
    for key, w in variants:
        edge += w
        if b < edge:
            return key
    raise AssertionError("weights must sum to 10000")


def golden() -> dict:
    rng = np.random.default_rng(SEED)
    splits = [
        [("control", 5000), ("treatment", 5000)],
        [("control", 9000), ("treatment", 1000)],
        [("a", 3334), ("b", 3333), ("c", 3333)],
        [("control", 2500), ("b", 2500), ("c", 2500), ("d", 2500)],
    ]
    salts = ["exp-checkout-2026", "a1b2c3d4", "héllo-☃", ""]
    rows = []
    for i in range(1000):
        salt = salts[i % len(salts)]
        unit = f"user-{int(rng.integers(0, 10**12))}" if i % 7 else f"𝄞-{i}"
        variants = splits[i % len(splits)]
        h = murmur3_32(f"{salt}:{unit}")
        rows.append({"salt": salt, "unit": unit, "hash": h, "bucket": h % 10_000, "variants": [{"key": k, "weight": w} for k, w in variants], "variant": assign(salt, unit, variants)})
    return {"generator": "tools/oracle/oracle.py", "note": "HO-01: frozen. If this file changes, every running experiment re-buckets.", "rows": rows}


# --- analysis -------------------------------------------------------------------------------------------------

def proportions_case(xa: int, na: int, xb: int, nb: int, alpha: float) -> dict:
    z, p = proportions_ztest([xb, xa], [nb, na])  # pooled, two-sided
    lo, hi = confint_proportions_2indep(xb, nb, xa, na, method="wald", compare="diff", alpha=alpha)
    pa, pb = xa / na, xb / nb
    return {"input": {"a": {"conversions": xa, "units": na}, "b": {"conversions": xb, "units": nb}, "alpha": alpha},
            "output": {"diff": pb - pa, "z": float(z), "p": float(p), "ciLow": float(lo), "ciHigh": float(hi)}}


def means_case(a: dict, b: dict, alpha: float) -> dict:
    if a["n"] < MIN_UNITS_PER_ARM or b["n"] < MIN_UNITS_PER_ARM:  # D-15: the z premise needs large n
        return {"input": {"a": a, "b": b, "alpha": alpha},
                "output": {"notEnoughData": True, "minUnitsPerArm": MIN_UNITS_PER_ARM, "unitsA": a["n"], "unitsB": b["n"]}}
    diff = b["mean"] - a["mean"]
    se = math.sqrt(a["variance"] / a["n"] + b["variance"] / b["n"])
    z = diff / se
    q = stats.norm.ppf(1 - alpha / 2)
    return {"input": {"a": a, "b": b, "alpha": alpha},
            "output": {"diff": diff, "se": se, "z": z, "p": float(2 * stats.norm.sf(abs(z))), "ciLow": diff - q * se, "ciHigh": diff + q * se}}


def srm_case(observed: list[int], weights: list[float]) -> dict:
    w = np.asarray(weights, dtype=float)
    exp = w / w.sum() * sum(observed)
    chi2, p = stats.chisquare(observed, exp)
    return {"input": {"observed": observed, "weights": weights}, "output": {"chi2": float(chi2), "p": float(p), "blocked": bool(p < 0.001)}}


def sequential_case(looks: list[dict], tau2: float, alpha: float) -> dict:
    out = []
    p_run, lo_run, hi_run, rej = 1.0, -np.inf, np.inf, False
    for lk in looks:
        d, v = lk["diff"], lk["variance"]
        ll = 0.5 * np.log(v / (v + tau2)) + tau2 * d * d / (2 * v * (v + tau2))
        p_run = min(p_run, min(1.0, float(np.exp(-ll))))
        h = np.sqrt(v * (v + tau2) / tau2 * (2 * np.log(1 / alpha) + np.log((v + tau2) / v)))
        lo_run, hi_run = max(lo_run, d - h), min(hi_run, d + h)
        rej = rej or bool(ll >= np.log(1 / alpha))
        out.append({"logLambda": float(ll), "p": p_run, "ciLow": float(lo_run), "ciHigh": float(hi_run), "reject": rej})
    return {"input": {"looks": looks, "tau2": tau2, "alpha": alpha}, "output": out}


def sample_size_prop(baseline: float, mde: float, alpha: float, power: float) -> float:
    p1, p2 = baseline, baseline + mde
    pbar = (p1 + p2) / 2
    za, zb = stats.norm.ppf(1 - alpha / 2), stats.norm.ppf(power)
    return float((za * math.sqrt(2 * pbar * (1 - pbar)) + zb * math.sqrt(p1 * (1 - p1) + p2 * (1 - p2))) ** 2 / mde**2)


def sample_size_mean(sd: float, mde: float, alpha: float, power: float) -> float:
    z = stats.norm.ppf(1 - alpha / 2) + stats.norm.ppf(power)
    return float(2 * sd**2 * z**2 / mde**2)


def vectors() -> dict:
    rng = np.random.default_rng(SEED)
    zs = [-8.0, -6.0, -3.5, -2.5, -1.959963984540054, -1.0, -0.3, 0.0, 0.3, 1.0, 1.6448536269514722, 2.5, 3.5, 6.0, 8.0]
    ps = [1e-10, 1e-6, 0.001, 0.0124, 0.025, 0.05, 0.2, 0.5, 0.8, 0.95, 0.975, 0.9876, 0.999, 1 - 1e-6]
    normal = {"cdf": [{"z": z, "v": float(stats.norm.cdf(z))} for z in zs],
              "twoSided": [{"z": z, "v": float(2 * stats.norm.sf(abs(z)))} for z in zs],
              "ppf": [{"p": p, "v": float(stats.norm.ppf(p))} for p in ps]}
    gamma = {"lnGamma": [{"x": x, "v": float(special.gammaln(x))} for x in [0.1, 0.5, 1.0, 1.5, 2.0, 3.7, 10.0, 50.5, 171.0]],
             "gammaQ": [{"a": a, "x": x, "v": float(special.gammaincc(a, x))} for a in [0.5, 1.0, 1.5, 3.0, 10.0] for x in [0.01, 0.5, 1.0, 2.5, 5.0, 12.0, 30.0]],
             "chi2Sf": [{"x": x, "df": df, "v": float(stats.chi2.sf(x, df))} for df in [1, 2, 3, 5] for x in [0.0, 0.1, 1.0, 3.84, 6.63, 10.83, 25.0]]}

    prop = [proportions_case(120, 1000, 150, 1000, 0.05), proportions_case(0, 500, 3, 500, 0.05), proportions_case(4980, 50000, 5210, 50210, 0.05),
            proportions_case(1, 10, 9, 10, 0.1), proportions_case(77, 3841, 77, 3841, 0.01)]
    for _ in range(25):
        na, nb = int(rng.integers(200, 200_000)), int(rng.integers(200, 200_000))
        p = float(rng.uniform(0.01, 0.6))
        lift = float(rng.uniform(-0.03, 0.03))
        xa = int(rng.binomial(na, p))
        xb = int(rng.binomial(nb, min(max(p + lift, 0.001), 0.999)))
        prop.append(proportions_case(xa, na, xb, nb, 0.05))

    means = [means_case({"n": 1570, "mean": 10.0, "variance": 25.0}, {"n": 1570, "mean": 10.5, "variance": 25.0}, 0.05),
             means_case({"n": 30, "mean": -2.5, "variance": 0.01}, {"n": 45, "mean": -2.49, "variance": 0.04}, 0.1),
             means_case({"n": 5, "mean": 10.0, "variance": 25.0}, {"n": 5, "mean": 14.0, "variance": 25.0}, 0.05),
             means_case({"n": 99, "mean": 10.0, "variance": 25.0}, {"n": 100, "mean": 11.0, "variance": 25.0}, 0.05),
             means_case({"n": 100, "mean": 10.0, "variance": 25.0}, {"n": 100, "mean": 11.0, "variance": 25.0}, 0.05)]
    for _ in range(25):
        a = {"n": int(rng.integers(50, 100_000)), "mean": float(rng.normal(50, 20)), "variance": float(rng.uniform(0.5, 400))}
        b = {"n": int(rng.integers(50, 100_000)), "mean": a["mean"] + float(rng.normal(0, 1)), "variance": float(rng.uniform(0.5, 400))}
        means.append(means_case(a, b, 0.05))

    srm = [srm_case([5000, 5000], [5000, 5000]), srm_case([5100, 4900], [1, 1]), srm_case([50700, 49300], [5000, 5000]),
           srm_case([9100, 900], [9000, 1000]), srm_case([3400, 3300, 3290], [3334, 3333, 3333]), srm_case([2600, 2500, 2400, 2500], [1, 1, 1, 1])]
    for _ in range(10):
        k = int(rng.integers(2, 5))
        w = rng.integers(500, 5000, size=k).astype(float)
        n = int(rng.integers(1000, 1_000_000))
        probs = w / w.sum() * (1 + rng.uniform(-0.01, 0.01, size=k))  # some splits slightly off, so both verdicts appear
        obs = rng.multinomial(n, probs / probs.sum()).tolist()
        srm.append(srm_case([int(o) for o in obs], [float(x) for x in w]))

    seq = []
    for case in range(8):
        tau2 = [0.0004, 0.25, 1e-4, 0.01][case % 4]
        sd_scale = math.sqrt(tau2) * float(rng.uniform(0.5, 3))
        looks = []
        for t in range(1, 16):
            v = (sd_scale * 4) ** 2 / t
            looks.append({"diff": float(rng.normal(math.sqrt(tau2) * (case % 3) * 0.5, math.sqrt(v))), "variance": v})
        seq.append(sequential_case(looks, tau2, [0.05, 0.1][case % 2]))

    ss = {"proportions": [{"baseline": b, "mde": m, "alpha": a, "power": pw, "v": sample_size_prop(b, m, a, pw)}
                          for (b, m, a, pw) in [(0.1, 0.02, 0.05, 0.8), (0.03, 0.003, 0.05, 0.8), (0.5, -0.05, 0.01, 0.9), (0.2, 0.01, 0.1, 0.8)]],
          "means": [{"sd": s, "mde": m, "alpha": a, "power": pw, "v": sample_size_mean(s, m, a, pw)}
                    for (s, m, a, pw) in [(5.0, 0.5, 0.05, 0.8), (1.0, 0.05, 0.05, 0.9), (120.0, -10.0, 0.01, 0.8)]]}

    return {"generator": "tools/oracle/oracle.py", "versions": {"python": sys.version.split()[0], "numpy": np.__version__, "scipy": __import__("scipy").__version__,
                                                                  "statsmodels": __import__("statsmodels").__version__},
            "tolerance": 1e-9, "normal": normal, "gamma": gamma, "proportions": prop, "means": means, "srm": srm, "sequential": seq, "sampleSize": ss}


def dump(obj: dict) -> str:
    return json.dumps(obj, indent=1, ensure_ascii=False) + "\n"


if __name__ == "__main__":
    VECTORS.write_text(dump(vectors()), encoding="utf-8")
    GOLDEN.parent.mkdir(parents=True, exist_ok=True)
    GOLDEN.write_text(dump(golden()), encoding="utf-8")
    print(f"wrote {VECTORS.relative_to(ROOT)} and {GOLDEN.relative_to(ROOT)}")
