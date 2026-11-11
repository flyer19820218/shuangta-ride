#!/usr/bin/env python3
"""把雙塔參考 GPX 轉成網頁用的 route.json。

用法：
    python3 tools/gpx2json.py <來源.gpx> route.json

輸出內容：
    track    軌跡點 [lat, lon, 海拔m]（海拔已平滑）
    pois     補給點 / 休息站 / 打卡點，附上在軌跡上的公里數
    detours  可切換的改道段（淡江大橋、台南外圍繞行）
"""
import json
import math
import os
import re
import sys
import xml.etree.ElementTree as ET

NS = {"g": "http://www.topografix.com/GPX/1/1"}


def hv(a, b):
    """兩點直線距離（公尺）。"""
    r = math.radians
    dl, dn = r(b[0] - a[0]), r(b[1] - a[1])
    h = math.sin(dl / 2) ** 2 + math.cos(r(a[0])) * math.cos(r(b[0])) * math.sin(dn / 2) ** 2
    return 2 * 6371000 * math.asin(math.sqrt(h))


def smooth(vals, win=3):
    """移動平均，壓掉 DEM 的鋸齒雜訊。"""
    out, h = [], win // 2
    for i in range(len(vals)):
        seg = vals[max(0, i - h): i + h + 1]
        out.append(sum(seg) / len(seg))
    return out


def ascent_descent(ele, thr=2.0):
    """用門檻（遲滯）計算累計爬升/下降，避免雜訊灌水。"""
    up = down = 0.0
    ref = ele[0]
    for e in ele[1:]:
        if e - ref >= thr:
            up += e - ref
            ref = e
        elif ref - e >= thr:
            down += ref - e
            ref = e
    return up, down


def classify(name):
    n = name.strip()
    if "起點" in n:
        return "start", ""
    if "終點" in n:
        return "end", ""
    if n.startswith("檢"):
        return "check", ""
    low = n.lower()
    if "7-eleven" in low or "7-11" in low or "7eleven" in low:
        return "store", "7-11"
    if "全家" in n:
        return "store", "全家"
    if "萊爾富" in n:
        return "store", "萊爾富"
    if n.startswith("OK") or "OK便利" in n:
        return "store", "OK"
    if "休息站" in n or "遊客中心" in n:
        return "rest", ""
    return "food", ""


def nearest_idx(track, p, cum_km):
    best, bi = 1e18, 0
    for i, t in enumerate(track):
        d = hv(p, t)
        if d < best:
            best, bi = d, i
    return bi, best


def idx_at_km(cum_km, km):
    return min(range(len(cum_km)), key=lambda i: abs(cum_km[i] - km))


def main(src, dst):
    root = ET.parse(src).getroot()
    pts = []
    for p in root.iter("{%s}trkpt" % NS["g"]):
        e = p.find("g:ele", NS)
        pts.append((float(p.get("lat")), float(p.get("lon")), float(e.text) if e is not None else 0.0))
    if not pts:
        sys.exit("GPX 裡沒有 trkpt")

    ele = smooth([p[2] for p in pts])
    track = [[round(p[0], 5), round(p[1], 5), round(ele[i])] for i, p in enumerate(pts)]

    cum = [0.0]
    for i in range(1, len(track)):
        cum.append(cum[-1] + hv(track[i - 1][:2], track[i][:2]) / 1000)
    up, down = ascent_descent([t[2] for t in track])  # 與網頁相同：用四捨五入後的海拔

    pois = []
    for w in root.iter("{%s}wpt" % NS["g"]):
        nm = w.find("g:name", NS)
        name = (nm.text or "").strip() if nm is not None else ""
        if not name:
            continue
        lat, lon = float(w.get("lat")), float(w.get("lon"))
        t, brand = classify(name)
        if t in ("start", "end"):
            continue
        i, dist = nearest_idx(track, (lat, lon), cum)
        pois.append({
            "n": name,
            "la": round(lat, 5),
            "lo": round(lon, 5),
            "t": t,
            "b": brand,
            "km": round(cum[i], 1),
            "off": round(dist),
        })
    pois.sort(key=lambda p: p["km"])

    def anchor(km):
        i = idx_at_km(cum, km)
        return {"idx": i, "lat": track[i][0], "lon": track[i][1], "km": round(cum[i], 1)}

    detours = [
        {
            "id": "danjiang",
            "name": "淡江大橋（淡水→八里直接過橋）",
            "note": "取代原路線繞關渡大橋的一段（淡江大橋 2026-05-12 通車）。"
                    "已用單車路由驗證：淡水到八里 10.1 km，比繞關渡的 19.0 km 短約 9 km。",
            "mode": "auto",
            "a": anchor(15.0),
            "b": anchor(34.0),
            "via": [],
            "default": True,
        },
        {
            "id": "tainan",
            "name": "台南外圍繞行（避開市區）",
            "note": "七股→西港→新市→歸仁→湖內。已用單車路由驗證：47.0 km（原路線 32.2 km，多約 15 km），"
                    "離台南市中心最近約 7.4 km（原路線最近 2.7 km）。",
            "mode": "via",
            "a": anchor(326.9),
            "b": anchor(359.1),
            "via": [
                [23.1217, 120.2036, "西港"],
                [23.0786, 120.2959, "新市"],
                [22.9672, 120.2928, "歸仁"],
            ],
            "default": True,
        },
    ]

    # 嵌入預先驗證的路線（tools/detour_segs.json），沒網路也能直接使用
    segs_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "detour_segs.json")
    if os.path.exists(segs_path):
        with open(segs_path, encoding="utf-8") as f:
            segs = json.load(f)
        for d in detours:
            s = segs.get(d["id"])
            if s:
                d["seg"] = [[round(p[0], 5), round(p[1], 5)] for p in s["seg"]]
                d["verified"] = s["verified"]

    out = {
        "meta": {
            "name": "雙塔 富貴角 → 鵝鑾鼻",
            "source": "網路參考 GPX《2023 TWB 雙塔520路徑規劃》",
            "km": round(cum[-1], 1),
            "ascent": round(up),
            "descent": round(down),
        },
        "track": track,
        "pois": pois,
        "detours": detours,
    }
    with open(dst, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
    print(f"track {len(track)} 點 / {cum[-1]:.1f} km / 爬升 {up:.0f} m / 下降 {down:.0f} m / 補給點 {len(pois)}")
    for d in detours:
        print(f"detour {d['id']}: km {d['a']['km']} → {d['b']['km']}（原路線 {d['b']['km'] - d['a']['km']:.1f} km）")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    main(sys.argv[1], sys.argv[2])
