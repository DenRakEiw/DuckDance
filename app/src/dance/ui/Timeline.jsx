// The command track, drawn.
//
// Seven curves, one per slot of the command the duck receives. This is
// the honest view of what the app actually produces: if the duck looks
// wrong, the answer is almost always visible here first, in a channel
// that is flat when it should move or pinned to its limit when it should
// breathe.

import { useEffect, useRef } from "react";
import Box from "@mui/material/Box";
import { useDance } from "../store.js";
import { CH, NUM_CH, LIMITS } from "../retarget.js";
import { MONO } from "../../theme.js";
import { COMIC_ORANGE, CREAM, ACID_CYAN, ACID_MAGENTA, COMIC_YELLOW } from "../../ui/comic.jsx";

const ROWS = [
  { ch: CH.VX, label: "vx", range: LIMITS.vxFwd, color: COMIC_ORANGE, hint: "forward" },
  { ch: CH.VY, label: "vy", range: LIMITS.vy, color: ACID_MAGENTA, hint: "sideways" },
  { ch: CH.WZ, label: "wz", range: LIMITS.wz, color: ACID_CYAN, hint: "turn" },
  { ch: CH.NECK_PITCH, label: "neck", range: LIMITS.head, color: COMIC_YELLOW, hint: "lean" },
  { ch: CH.HEAD_PITCH, label: "nod", range: LIMITS.head, color: CREAM, hint: "nod" },
  { ch: CH.HEAD_YAW, label: "turn", range: LIMITS.head, color: CREAM, hint: "head turn" },
  { ch: CH.HEAD_ROLL, label: "tilt", range: LIMITS.head, color: CREAM, hint: "head tilt" },
];

const ROW_H = 22;

export default function Timeline() {
  const ref = useRef(null);
  const track = useDance((s) => s.track);
  const currentTime = useDance((s) => s.currentTime);
  const duration = useDance((s) => s.duration);
  const events = useDance((s) => s.events);

  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = cv.clientWidth, h = ROWS.length * ROW_H;
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(h * dpr);
    cv.style.height = `${h}px`;
    const ctx = cv.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (!track || !track.n) return;

    ROWS.forEach((row, r) => {
      const top = r * ROW_H;
      const mid = top + ROW_H / 2;
      // Zero line.
      ctx.strokeStyle = "rgba(255,255,255,0.10)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, mid + 0.5);
      ctx.lineTo(w, mid + 0.5);
      ctx.stroke();

      // One vertical pixel column per screen pixel, taking the extremes of
      // whatever samples fall inside it: at 50 Hz a long clip has many
      // more samples than pixels, and plotting only the first of each
      // group would hide exactly the spikes worth seeing.
      ctx.strokeStyle = row.color;
      ctx.lineWidth = 1;
      ctx.beginPath();
      const amp = (ROW_H / 2) - 2;
      for (let x = 0; x < w; x++) {
        const i0 = Math.floor((x / w) * track.n);
        const i1 = Math.max(i0 + 1, Math.floor(((x + 1) / w) * track.n));
        let lo = Infinity, hi = -Infinity;
        for (let i = i0; i < i1 && i < track.n; i++) {
          const v = track.data[i * NUM_CH + row.ch];
          if (v < lo) lo = v;
          if (v > hi) hi = v;
        }
        if (lo === Infinity) continue;
        const y0 = mid - (hi / row.range) * amp;
        const y1 = mid - (lo / row.range) * amp;
        ctx.moveTo(x + 0.5, y0);
        ctx.lineTo(x + 0.5, Math.max(y1, y0 + 0.6));
      }
      ctx.stroke();
    });
  }, [track]);

  const pct = duration > 0 ? (currentTime / duration) * 100 : 0;

  return (
    <Box sx={{ position: "relative" }}>
      <Box sx={{ display: "flex" }}>
        <Box sx={{ width: 42, flexShrink: 0 }}>
          {ROWS.map((r) => (
            <Box key={r.label} sx={{
              height: ROW_H, display: "flex", alignItems: "center",
              fontFamily: MONO, fontSize: "0.58rem", color: r.color,
            }}>
              {r.label}
            </Box>
          ))}
        </Box>
        <Box sx={{ position: "relative", flex: 1, minWidth: 0 }}>
          <Box component="canvas" ref={ref}
            sx={{ width: "100%", display: "block" }} />
          {duration > 0 && (
            <Box sx={{
              position: "absolute", left: `${pct}%`, top: 0, bottom: 0,
              width: 1, background: CREAM, opacity: 0.8, pointerEvents: "none",
            }} />
          )}
        </Box>
      </Box>
      <Box sx={{ display: "flex", gap: 1.4, mt: 0.6, flexWrap: "wrap",
        fontFamily: MONO, fontSize: "0.55rem", color: "rgba(255,255,255,0.4)" }}>
        {ROWS.map((r) => (
          <Box key={r.label}>
            <Box component="span" sx={{ color: r.color }}>{r.label}</Box>
            {" "}{r.hint}
          </Box>
        ))}
        <Box sx={{ ml: "auto" }}>{events.length} moves</Box>
      </Box>
    </Box>
  );
}
