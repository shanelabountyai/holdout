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
