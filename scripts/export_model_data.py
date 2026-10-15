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

# The pipeline's chosen estimator is the RSSI-weighted centroid (lowest median error);
# NLS estimates are kept only for comparison.
aps = pd.read_parquet(src / "ap_position_estimates.parquet")[[
    "ap_id", "n_detections", "centroid_e", "centroid_n", "nls_joint_e", "nls_joint_n",
    "floor_est", "true_e", "true_n", "true_floor", "centroid_err_2d_m", "nls_joint_err_2d_m",
    "centre_err_2d_m", "nls_fixed_err_2d_m", "floor_correct"]]

res = pd.read_parquet(src / "residuals.parquet")
# Per-AP metadata (MAC/band) observed in the survey
ap_meta = res.groupby("ap_id").agg(macs=("mac", lambda m: sorted(set(m))), band=("band", "first")).reset_index()
aps = aps.merge(ap_meta, on="ap_id", how="left")

# Survey trace: unique scan points ordered along the corridor -> used as robot path and for replay
trace = res[["floor", "e", "n"]].drop_duplicates().sort_values(["floor", "n", "e"]).reset_index(drop=True)
samples = res[["floor", "e", "n", "mac", "rssi", "band", "ap_id", "predicted_rssi", "residual"]]

# Cluster model: the pipeline's 5 clusters are reproduced exactly by nearest centroid
# on these standardised features, so live/replay cells can be classified the same way.
FEATS = ["rssi_best_mean", "rssi_spatial_std", "rssi_all_mean", "n_aps_visible", "best_second_gap"]
X = rec_full = pd.read_parquet(src / "recommendations.parquet")
Xf = X[FEATS].fillna(X[FEATS].median())
mu, sd = Xf.mean(), Xf.std(ddof=0)
Z = (Xf - mu) / sd
cent = Z.groupby(X.cluster).mean()
cluster_model = {
    "features": FEATS,
    "mean": [float(mu[f]) for f in FEATS],
    "std": [float(sd[f]) for f in FEATS],
    "fill": [float(Xf[f].median()) for f in FEATS],
    "clusters": [{
        "cluster": int(c), "centroid": [float(v) for v in cent.loc[c]],
        "name": X[X.cluster == c].cluster_name.iloc[0], "action": X[X.cluster == c].action.iloc[0],
        "n": int((X.cluster == c).sum()),
        "profile": {f: round(float(X[X.cluster == c][f].mean()), 2) for f in FEATS},
    } for c in cent.index],
}
assert (cent.index.values[((Z.values[:, None] - cent.values[None]) ** 2).sum(-1).argmin(1)] == X.cluster.values).all()

# Gaussian-process interpolation of best-AP RSSI per floor -> mean + predictive std (uncertainty)
from sklearn.gaussian_process import GaussianProcessRegressor
from sklearn.gaussian_process.kernels import RBF, WhiteKernel, ConstantKernel
import numpy as np
gp_out = []
for f, d in grid.groupby("floor"):
    xy = d[["e", "n"]].values; y = d.rssi_best_mean.values
    k = ConstantKernel(10.0) * RBF(length_scale=4.0, length_scale_bounds=(0.5, 50)) + WhiteKernel(1.0, noise_level_bounds=(1e-2, 10))
    gp = GaussianProcessRegressor(kernel=k, normalize_y=True, n_restarts_optimizer=3, random_state=0).fit(xy, y)
    E, N = np.meshgrid(np.arange(d.e.min() - 2, d.e.max() + 2.01, 1.0), np.arange(d.n.min() - 2, d.n.max() + 2.01, 1.0))
    q = np.c_[E.ravel(), N.ravel()]
    near = np.min(np.hypot(q[:, None, 0] - xy[None, :, 0], q[:, None, 1] - xy[None, :, 1]), 1) <= 3.0
    mean, std = gp.predict(q[near], return_std=True)
    gp_out.append({"floor": int(f), "kernel": str(gp.kernel_), "step": 1.0,
                   "points": [[round(a, 1), round(b, 1), round(m, 2), round(s, 2)] for (a, b), m, s in zip(q[near], mean, std)]})

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
    "cluster_model": cluster_model,
    "gp": gp_out,
    "trace": records(trace),
    "samples": [[int(r.floor), r.e, r.n, r.mac, r.rssi, r.band] for r in samples.itertuples()],
    "coverage_vs_ap": records(pd.read_csv(src / "coverage_vs_ap_count.csv")),
    "benchmark": records(bench_summary),
    "benchmark_folds": records(bench),
    "feature_importance": records(pd.read_csv(src / "ml_benchmark_hybrid_feature_importances.csv")),
    "residual_hist": (lambda h: {"edges": [float(x) for x in h[1]], "counts": [int(x) for x in h[0]],
                                  "rmse": float(np.sqrt((res.residual ** 2).mean())),
                                  "mean": float(res.residual.mean())})(np.histogram(res.residual, bins=np.arange(-48, 44, 4))),
}
out.parent.mkdir(exist_ok=True)
out.write_text(json.dumps(data, separators=(",", ":")))
print(f"wrote {out} ({out.stat().st_size/1024:.0f} KB)")
