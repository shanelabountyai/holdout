"""The committed oracle outputs must be what oracle.py produces now (run `python tools/oracle/oracle.py` to refresh)."""

import json
import math
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent))
import oracle  # noqa: E402


def close(a, b, path="$"):
    if isinstance(a, dict):
        assert a.keys() == b.keys(), path
        for k in a:
            if k != "versions":
                close(a[k], b[k], f"{path}.{k}")
    elif isinstance(a, list):
        assert len(a) == len(b), path
        for i, (x, y) in enumerate(zip(a, b)):
            close(x, y, f"{path}[{i}]")
    elif isinstance(a, float) and isinstance(b, (int, float)):
        assert math.isclose(a, b, rel_tol=1e-12, abs_tol=1e-13), f"{path}: committed {a} vs fresh {b}"
    else:
        assert a == b, f"{path}: committed {a!r} vs fresh {b!r}"


def test_vectors_fresh():
    close(json.loads(oracle.VECTORS.read_text(encoding="utf-8")), oracle.vectors())


def test_golden_fresh():
    assert json.loads(oracle.GOLDEN.read_text(encoding="utf-8")) == oracle.golden()


def test_murmur3_reference_values():
    # Published MurmurHash3_x86_32 values.
    assert oracle.murmur3_32("", 0) == 0
    assert oracle.murmur3_32("", 1) == 0x514E28B7
    assert oracle.murmur3_32("hello", 0) == 0x248BFA47
    assert oracle.murmur3_32("Hello, world!", 1234) == 0xFAF6CDB3


def test_murmur3_matches_mmh3_if_installed():
    mmh3 = pytest.importorskip("mmh3")
    for row in oracle.golden()["rows"][:300]:
        key = f"{row['salt']}:{row['unit']}"
        assert oracle.murmur3_32(key) == mmh3.hash(key, 0, signed=False)


def test_sequential_plans_at_twice_the_fixed_horizon():
    # D-16 (resolves D-14): sequential experiments plan at 2x the fixed-horizon n; TS mirrors this in tests.ts.
    assert oracle.SEQUENTIAL_HORIZON_MULTIPLIER == 2
    n = oracle.sample_size_prop(0.1, 0.02, 0.05, 0.8)
    assert oracle.planned_units_per_arm(n, "fixed") == 3841
    assert oracle.planned_units_per_arm(n, "sequential") == 7682
    m = oracle.sample_size_mean(5.0, 0.5, 0.05, 0.8)
    assert (oracle.planned_units_per_arm(m, "fixed"), oracle.planned_units_per_arm(m, "sequential")) == (1570, 3140)
    for case in oracle.vectors()["sampleSize"]["proportions"] + oracle.vectors()["sampleSize"]["means"]:
        assert case["planned"]["sequential"] == 2 * case["planned"]["fixed"]


def test_srm_minimum_sample_detects_the_case_study_loss():
    # D-41: the SRM check counts as checkable once a loss of 8% of one arm's exposures would be caught at p < 0.001
    # with 80% power. For 50/50 that is 9 835 units in total; TS mirrors the constants in src/lib/exp/srm.ts.
    assert (oracle.SRM_ALPHA, oracle.SRM_DETECTABLE_LOSS, oracle.SRM_POWER) == (0.001, 0.08, 0.8)
    c = oracle.srm_power_case([5000, 5000], 0.08, 0.001, 0.8)["output"]
    assert c["minTotalUnits"] == 9835
    # df = 1 has a closed form: power = Phi(sqrt(lambda) - z) + Phi(-sqrt(lambda) - z), z = z_(1 - alpha/2).
    z = oracle.stats.norm.isf(0.0005)
    r = math.sqrt(c["lambda"])
    assert math.isclose(oracle.stats.norm.cdf(r - z) + oracle.stats.norm.cdf(-r - z), 0.8, rel_tol=1e-10)
    # A bigger loss needs fewer units; more power needs more.
    assert oracle.srm_power_case([1, 1], 0.2, 0.001, 0.8)["output"]["minTotalUnits"] < c["minTotalUnits"]
    assert oracle.srm_power_case([1, 1], 0.08, 0.001, 0.95)["output"]["minTotalUnits"] > c["minTotalUnits"]
