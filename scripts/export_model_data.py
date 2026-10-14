"""Export the GridSense model outputs (parquet/csv) into data/gridsense.json for the website.

Usage:  py scripts/export_model_data.py <path-to-model-outputs-folder>
"""
import json, sys, math
from pathlib import Path
import pandas as pd

src = Path(sys.argv[1] if len(sys.argv) > 1 else "outputs")
out = Path(__file__).resolve().parent.parent / "data" / "gridsense.json"

def clean(v):
    if isinstance(v, float):
        return None if math.isnan(v) else round(v, 3)
    if hasattr(v, "item"):
        return clean(v.item())
    return v

def records(df):
    return [{k: clean(v) for k, v in row.items()} for row in df.to_dict("records")]

grid = pd.read_parquet(src / "grid_with_contention.parquet")
rec = pd.read_parquet(src / "recommendations.parquet")[["floor", "e", "n", "cluster", "cluster_name", "threshold_label", "action"]]
cells = grid.merge(rec, on=["floor", "e", "n"], how="left")

aps = pd.read_parquet(src / "ap_position_estimates.parquet")[[
    "ap_id", "n_detections", "nls_joint_e", "nls_joint_n", "nls_joint_A", "nls_joint_exponent",
    "floor_est", "true_e", "true_n", "true_floor", "nls_joint_err_2d_m", "centroid_err_2d_m",
    "centre_err_2d_m", "nls_fixed_err_2d_m", "floor_correct"]]

res = pd.read_parquet(src / "residuals.parquet")
# Per-AP metadata (MAC/band) observed in the survey
ap_meta = res.groupby("ap_id").agg(mac=("mac", "first"), band=("band", "first")).reset_index()
aps = aps.merge(ap_meta, on="ap_id", how="left")

# Survey trace: unique scan points ordered along the corridor -> used as robot path and for replay
trace = res[["floor", "e", "n"]].drop_duplicates().sort_values(["floor", "n", "e"]).reset_index(drop=True)
samples = res[["floor", "e", "n", "mac", "rssi", "band", "ap_id", "predicted_rssi", "residual"]]

bench = pd.read_csv(src / "ml_benchmark_results.csv")
bench_summary = (bench.groupby(["strategy", "model"]).rmse_db.agg(["mean", "std"]).reset_index())

data = {
    "meta": {
        "n_samples": int(len(res)),
        "n_scan_points": int(len(trace)),
        "n_aps": int(len(aps)),
        "n_macs": int(res.mac.nunique()),
        "floors": sorted(int(f) for f in cells.floor.unique()),
    },
    "cells": records(cells),
    "aps": records(aps),
    "trace": records(trace),
    "samples": [[int(r.floor), r.e, r.n, r.mac, r.rssi, r.band] for r in samples.itertuples()],
    "coverage_vs_ap": records(pd.read_csv(src / "coverage_vs_ap_count.csv")),
    "benchmark": records(bench_summary),
    "benchmark_folds": records(bench),
    "feature_importance": records(pd.read_csv(src / "ml_benchmark_hybrid_feature_importances.csv")),
    "residual_hist": records(
        pd.cut(res.residual, bins=range(-46, 44, 4)).value_counts(sort=False)
        .rename_axis("bin").reset_index().assign(bin=lambda d: d.bin.map(lambda b: int(b.left)))
    ),
}
out.parent.mkdir(exist_ok=True)
out.write_text(json.dumps(data, separators=(",", ":")))
print(f"wrote {out} ({out.stat().st_size/1024:.0f} KB)")
