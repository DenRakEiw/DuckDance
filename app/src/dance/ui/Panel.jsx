// Shared chrome for the dance lab, in the sandbox's own comic vocabulary:
// a thick cream keyline on a dark glass plate, with the caption box
// straddling the frame's top edge like a caption on a comic panel.

import Box from "@mui/material/Box";
import { ANTON, CREAM, COMIC_INK, COMIC_ORANGE } from "../../ui/comic.jsx";
import { MONO } from "../../theme.js";

export function Panel({ title, accent = CREAM, right, children, sx, dense = false }) {
  return (
    <Box sx={{ position: "relative", mt: 1.6, ...sx }}>
      <Box
        sx={{
          border: `3px solid ${accent}`,
          background: "rgba(8,8,12,0.72)",
          boxShadow: `inset 0 0 0 1px ${COMIC_INK}`,
          px: dense ? 1.2 : 1.6,
          pt: 1.9,
          pb: dense ? 1.2 : 1.6,
        }}
      >
        {children}
      </Box>
      {title && (
        <Box
          sx={{
            position: "absolute", top: -10, left: 12,
            display: "flex", alignItems: "center", gap: 1,
            background: accent, color: COMIC_INK,
            border: `2px solid ${COMIC_INK}`,
            boxShadow: `2px 2px 0 ${COMIC_INK}`,
            px: 1, py: 0.15,
            fontFamily: ANTON, fontSize: "0.72rem",
            letterSpacing: "0.08em", textTransform: "uppercase",
            whiteSpace: "nowrap",
          }}
        >
          {title}
        </Box>
      )}
      {right && (
        <Box
          sx={{
            position: "absolute", top: -9, right: 12,
            fontFamily: MONO, fontSize: "0.64rem",
            color: "rgba(255,255,255,0.6)",
            background: COMIC_INK, px: 0.8, py: 0.25,
            border: "1px solid rgba(255,255,255,0.18)",
            whiteSpace: "nowrap",
          }}
        >
          {right}
        </Box>
      )}
    </Box>
  );
}

/** A labelled horizontal bar for a signed value, centred on zero. */
export function Meter({ label, value, range = 1, color = COMIC_ORANGE, unit = "" }) {
  const v = Math.max(-1, Math.min(1, (value ?? 0) / range));
  const pct = Math.abs(v) * 50;
  return (
    <Box sx={{ display: "flex", alignItems: "center", gap: 1, mb: 0.45 }}>
      <Box sx={{ fontFamily: MONO, fontSize: "0.6rem", width: 52,
        color: "rgba(255,255,255,0.5)", textTransform: "uppercase" }}>
        {label}
      </Box>
      <Box sx={{ position: "relative", flex: 1, height: 9,
        background: "rgba(255,255,255,0.06)",
        border: "1px solid rgba(255,255,255,0.12)" }}>
        <Box sx={{ position: "absolute", left: "50%", top: 0, bottom: 0,
          width: "1px", background: "rgba(255,255,255,0.25)" }} />
        <Box sx={{
          position: "absolute", top: 1, bottom: 1, background: color,
          left: v >= 0 ? "50%" : `${50 - pct}%`, width: `${pct}%`,
        }} />
      </Box>
      <Box sx={{ fontFamily: MONO, fontSize: "0.6rem", width: 48,
        textAlign: "right", color: "rgba(255,255,255,0.7)" }}>
        {(value ?? 0).toFixed(2)}{unit}
      </Box>
    </Box>
  );
}

/** A compact labelled slider row. */
export function Knob({ label, value, min, max, step = 0.05, onChange, hint, format }) {
  return (
    <Box sx={{ mb: 1 }}>
      <Box sx={{ display: "flex", justifyContent: "space-between",
        alignItems: "baseline", mb: 0.15 }}>
        <Box sx={{ fontFamily: MONO, fontSize: "0.66rem",
          color: "rgba(255,255,255,0.72)" }}>{label}</Box>
        <Box sx={{ fontFamily: MONO, fontSize: "0.66rem", color: COMIC_ORANGE }}>
          {format ? format(value) : value.toFixed(2)}
        </Box>
      </Box>
      <Box
        component="input"
        type="range"
        min={min} max={max} step={step} value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        sx={{
          width: "100%", height: 16, appearance: "none", background: "transparent",
          cursor: "pointer",
          "&::-webkit-slider-runnable-track": {
            height: 4, background: "rgba(255,255,255,0.16)",
          },
          "&::-webkit-slider-thumb": {
            appearance: "none", width: 12, height: 12, marginTop: "-4px",
            background: COMIC_ORANGE, border: `2px solid ${COMIC_INK}`,
          },
          "&::-moz-range-track": { height: 4, background: "rgba(255,255,255,0.16)" },
          "&::-moz-range-thumb": {
            width: 12, height: 12, border: `2px solid ${COMIC_INK}`,
            background: COMIC_ORANGE, borderRadius: 0,
          },
        }}
      />
      {hint && (
        <Box sx={{ fontFamily: MONO, fontSize: "0.58rem",
          color: "rgba(255,255,255,0.38)", mt: -0.3 }}>{hint}</Box>
      )}
    </Box>
  );
}

/** A checkbox row that matches the keyline language. */
export function Toggle({ label, checked, onChange, hint }) {
  return (
    <Box
      onClick={() => onChange(!checked)}
      sx={{ display: "flex", alignItems: "flex-start", gap: 1, mb: 0.7,
        cursor: "pointer", userSelect: "none" }}
    >
      <Box sx={{
        width: 14, height: 14, mt: "1px", flexShrink: 0,
        border: `2px solid ${checked ? COMIC_ORANGE : "rgba(255,255,255,0.35)"}`,
        background: checked ? COMIC_ORANGE : "transparent",
      }} />
      <Box>
        <Box sx={{ fontFamily: MONO, fontSize: "0.66rem",
          color: "rgba(255,255,255,0.78)" }}>{label}</Box>
        {hint && (
          <Box sx={{ fontFamily: MONO, fontSize: "0.58rem",
            color: "rgba(255,255,255,0.38)" }}>{hint}</Box>
        )}
      </Box>
    </Box>
  );
}
