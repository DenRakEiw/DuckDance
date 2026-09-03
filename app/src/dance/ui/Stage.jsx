// The video, the tracked skeleton drawn over it, and the transport.
//
// The stage owns the clock the whole app runs on: an uploaded clip plays
// through a real video element, the built-in routine through a synthetic
// one, and either way the element is handed to the player, which reads
// its currentTime and asks for nothing else. That is why scrubbing works
// on the duck without any code here knowing the duck exists.

import { useEffect, useRef, useState } from "react";
import Box from "@mui/material/Box";
import { drawPose, frameAt } from "../draw.js";
import { synthPose } from "../synth.js";
import { useDance } from "../store.js";
import { MONO } from "../../theme.js";
import { COMIC_INK, COMIC_ORANGE, CREAM, ACID_CYAN } from "../../ui/comic.jsx";

const fmt = (t) => {
  if (!Number.isFinite(t)) return "0:00.0";
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, "0")}`;
};

function TransportButton({ children, onClick, active, wide, title }) {
  return (
    <Box
      component="button"
      onClick={onClick}
      title={title}
      sx={{
        fontFamily: MONO, fontSize: "0.7rem", lineHeight: 1,
        px: wide ? 1.6 : 1.1, py: 0.75, cursor: "pointer",
        color: active ? COMIC_INK : CREAM,
        background: active ? COMIC_ORANGE : "transparent",
        border: `2px solid ${active ? COMIC_ORANGE : "rgba(255,255,255,0.3)"}`,
        transition: "background 120ms, border-color 120ms",
        "&:hover": { borderColor: COMIC_ORANGE },
      }}
    >
      {children}
    </Box>
  );
}

// What a song looks like when there is no dancer to show.
//
// The blocks are the sections the analysis found, coloured by how loud
// each one is, because that is exactly what decides how big the duck
// dances there. Seeing the routine change at a block edge is the quickest
// way to tell whether the structure was read correctly.
const SECTION_TINT = {
  peak: "rgba(255,122,0,0.55)",
  groove: "rgba(0,214,214,0.34)",
  calm: "rgba(255,255,255,0.10)",
};

function SongMap({ music, currentTime, duration }) {
  const secs = music?.sections ?? [];
  const dur = duration || music?.duration || 1;
  return (
    <Box sx={{ position: "absolute", inset: 0, display: "flex",
      flexDirection: "column", justifyContent: "center", px: 2.5, gap: 1.2 }}>
      <Box sx={{ fontFamily: MONO, fontSize: "0.62rem",
        color: "rgba(255,255,255,0.42)", letterSpacing: "0.06em" }}>
        {music ? `${Math.round(music.bpm)} BPM · ${music.bars.length} bars · ${secs.length} section${secs.length === 1 ? "" : "s"}` : "listening"}
      </Box>
      <Box sx={{ position: "relative", height: 54, display: "flex",
        border: "1px solid rgba(255,255,255,0.16)" }}>
        {secs.map((sec) => (
          <Box key={sec.index}
            title={`${sec.kind}, bars ${sec.i0 + 1}-${sec.i1}`}
            sx={{
              width: `${((sec.t1 - sec.t0) / dur) * 100}%`,
              background: SECTION_TINT[sec.kind] ?? SECTION_TINT.groove,
              borderRight: "1px solid rgba(0,0,0,0.5)",
              display: "flex", alignItems: "flex-end",
            }}>
            <Box sx={{ fontFamily: MONO, fontSize: "0.52rem", p: 0.4,
              color: "rgba(255,255,255,0.7)" }}>{sec.kind}</Box>
          </Box>
        ))}
        <Box sx={{ position: "absolute", top: 0, bottom: 0,
          left: `${Math.min(100, (currentTime / dur) * 100)}%`,
          width: 2, background: "#fff", opacity: 0.85 }} />
      </Box>
      <Box sx={{ fontFamily: MONO, fontSize: "0.58rem",
        color: "rgba(255,255,255,0.3)" }}>
        No video. The routine is choreographed from the music.
      </Box>
    </Box>
  );
}

export default function Stage({ media, onSeek, onTogglePlay }) {
  const wrapRef = useRef(null);
  const canvasRef = useRef(null);
  const videoRef = useRef(null);
  const [box, setBox] = useState({ w: 0, h: 0 });

  const videoUrl = useDance((s) => s.videoUrl);
  const isDemo = useDance((s) => s.isDemo);
  const isAudio = useDance((s) => s.isAudio);
  const music = useDance((s) => s.music);
  const frames = useDance((s) => s.frames);
  const currentTime = useDance((s) => s.currentTime);
  const duration = useDance((s) => s.duration);
  const playing = useDance((s) => s.playing);
  const stage = useDance((s) => s.stage);
  const mirror = useDance((s) => s.tuning.mirror);
  const beats = useDance((s) => s.beats);
  const events = useDance((s) => s.events);

  // Hand the real <video> up to the lab, which gives it to the player.
  useEffect(() => {
    if (!isDemo && videoRef.current) media.register(videoRef.current);
  }, [isDemo, videoUrl, media]);

  // Keep the overlay canvas matched to its container in device pixels, so
  // the skeleton stays crisp on a high-DPI screen and never stretches.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      setBox({ w: r.width, h: r.height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Redraw the skeleton whenever the playhead or the pose data moves.
  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv || !box.w) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    cv.width = Math.round(box.w * dpr);
    cv.height = Math.round(box.h * dpr);
    const ctx = cv.getContext("2d");
    if (!frames) { ctx.clearRect(0, 0, cv.width, cv.height); return; }
    const i = frameAt(frames, currentTime);
    const lms = i >= 0 ? frames[i].landmarks : null;
    drawPose(ctx, lms, cv.width, cv.height, { mirror, scale: dpr });
  }, [frames, currentTime, box, mirror]);

  const trackedNow = (() => {
    if (!frames) return null;
    const i = frameAt(frames, currentTime);
    return i >= 0 ? !!frames[i].landmarks : null;
  })();

  const pct = duration > 0 ? (currentTime / duration) * 100 : 0;

  return (
    <Box>
      <Box
        ref={wrapRef}
        sx={{
          position: "relative", width: "100%", aspectRatio: "16 / 10",
          background: "#05050a", border: `2px solid rgba(255,255,255,0.14)`,
          overflow: "hidden", display: "flex",
          alignItems: "center", justifyContent: "center",
        }}
      >
        {videoUrl && !isDemo && (
          <Box
            component={isAudio ? "audio" : "video"}
            ref={videoRef}
            src={videoUrl}
            muted={false}
            playsInline
            sx={isAudio ? { display: "none" } : {
              width: "100%", height: "100%", objectFit: "contain",
              transform: mirror ? "scaleX(-1)" : "none",
            }}
          />
        )}
        {isAudio && (
          <SongMap music={music} currentTime={currentTime} duration={duration} />
        )}
        {isDemo && (
          <Box sx={{ fontFamily: MONO, fontSize: "0.66rem",
            color: "rgba(255,255,255,0.3)", textAlign: "center", px: 3 }}>
            Built-in routine.<br />No video, just the pose the duck is following.
          </Box>
        )}
        {!videoUrl && !isDemo && stage === "idle" && (
          <Box sx={{ fontFamily: MONO, fontSize: "0.68rem",
            color: "rgba(255,255,255,0.28)" }}>
            no clip loaded
          </Box>
        )}
        <Box
          component="canvas"
          ref={canvasRef}
          sx={{ position: "absolute", inset: 0, width: "100%", height: "100%",
            pointerEvents: "none" }}
        />
        {trackedNow === false && (
          <Box sx={{
            position: "absolute", top: 8, left: 8, fontFamily: MONO,
            fontSize: "0.6rem", color: COMIC_INK, background: "#ff5a5a",
            px: 0.8, py: 0.2, border: `1px solid ${COMIC_INK}`,
          }}>
            NO DANCER FOUND
          </Box>
        )}
      </Box>

      {/* Scrubber, with the beat grid and the scheduled moves drawn on it
          so the timing of a routine is visible at a glance. */}
      <Box
        onPointerDown={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          const seek = (clientX) => {
            const x = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
            onSeek(x * duration);
          };
          seek(e.clientX);
          const move = (ev) => seek(ev.clientX);
          const up = () => {
            window.removeEventListener("pointermove", move);
            window.removeEventListener("pointerup", up);
          };
          window.addEventListener("pointermove", move);
          window.addEventListener("pointerup", up);
        }}
        sx={{
          position: "relative", height: 26, mt: 0.9, cursor: "pointer",
          background: "rgba(255,255,255,0.05)",
          border: "1px solid rgba(255,255,255,0.14)",
          touchAction: "none",
        }}
      >
        {duration > 0 && beats.map((b, i) => (
          <Box key={`b${i}`} sx={{
            position: "absolute", left: `${(b / duration) * 100}%`,
            top: 0, bottom: 0, width: "1px",
            background: i % 4 === 0 ? "rgba(47,240,230,0.45)" : "rgba(255,255,255,0.12)",
          }} />
        ))}
        {duration > 0 && events.map((e, i) => (
          <Box key={`e${i}`} title={`${e.type} at ${e.t.toFixed(2)}s`} sx={{
            position: "absolute", left: `${(e.t / duration) * 100}%`,
            top: 3, width: 3, height: 8, ml: "-1px",
            background: e.type.startsWith("kick") ? COMIC_ORANGE
              : e.type === "pick" ? ACID_CYAN : CREAM,
          }} />
        ))}
        <Box sx={{
          position: "absolute", left: 0, top: "auto", bottom: 0,
          height: 4, width: `${pct}%`, background: COMIC_ORANGE,
        }} />
        <Box sx={{
          position: "absolute", left: `${pct}%`, top: 0, bottom: 0,
          width: 2, ml: "-1px", background: CREAM,
        }} />
      </Box>

      <Box sx={{ display: "flex", alignItems: "center", gap: 0.7, mt: 0.9 }}>
        <TransportButton onClick={onTogglePlay} active={playing} wide
          title={playing ? "Pause" : "Play the routine"}>
          {playing ? "PAUSE" : "PLAY"}
        </TransportButton>
        <TransportButton onClick={() => onSeek(0)} title="Back to the start">
          RESTART
        </TransportButton>
        <Box sx={{ flex: 1 }} />
        <Box sx={{ fontFamily: MONO, fontSize: "0.66rem",
          color: "rgba(255,255,255,0.6)" }}>
          {fmt(currentTime)} / {fmt(duration)}
        </Box>
      </Box>
    </Box>
  );
}
