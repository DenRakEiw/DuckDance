// The left half of the app: upload a dance video, watch it get analysed,
// then drive the duck with it.
//
// The lab owns the two objects that connect the halves -- the media clock
// and the player -- and otherwise just renders store state. Everything
// expensive happens once, in the store; the sliders here only re-run the
// arithmetic downstream of the tracked frames, which is why they feel
// immediate rather than like a re-analysis.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Box from "@mui/material/Box";
import { gameApi, useGame } from "../../store.js";
import { ComicButton, ANTON, CREAM, COMIC_INK, COMIC_ORANGE, COMIC_YELLOW, ACID_CYAN } from "../../ui/comic.jsx";
import { MONO } from "../../theme.js";
import { Panel, Meter, Knob, Toggle } from "./Panel.jsx";
import Stage from "./Stage.jsx";
import { closeMenu } from "../../ui/TitleMenu.jsx";
import Timeline from "./Timeline.jsx";
import { DancePlayer } from "../player.js";
import { SyntheticClock } from "../clock.js";
import { CH, LIMITS } from "../retarget.js";
import {
  useDance, analyseFile, loadDemo, reset, cancelAnalysis,
  setTuning, setMoveTuning, setPlayback, setCaptureOpts,
} from "../store.js";

const MOVE_LABEL = {
  kickL: "kick left", kickR: "kick right", pick: "bow",
  sit: "sit down", stand: "stand up", roll: "roulade",
};

function Row({ children, gap = 1 }) {
  return <Box sx={{ display: "flex", alignItems: "center", gap, flexWrap: "wrap" }}>{children}</Box>;
}

// Resolve once the simulator will actually accept commands: boot done,
// entrance played out, no fall recovery in progress. Times out rather
// than hanging the button forever if the sim never gets there.
function waitForDuck(timeoutMs) {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const poll = () => {
      if (gameApi.dance?.status?.ready) return resolve(true);
      if (performance.now() - t0 > timeoutMs) return resolve(false);
      setTimeout(poll, 50);
    };
    poll();
  });
}

function Note({ children, tone = "dim" }) {
  const color = tone === "warn" ? "#ffb45a" : tone === "bad" ? "#ff6b6b" : "rgba(255,255,255,0.45)";
  return (
    <Box sx={{ fontFamily: MONO, fontSize: "0.62rem", color, mt: 0.6, lineHeight: 1.5 }}>
      {children}
    </Box>
  );
}

export default function DanceLab() {
  const fileRef = useRef(null);
  const clockRef = useRef(null);
  const videoRef = useRef(null);
  const playerRef = useRef(null);
  const [dragging, setDragging] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [startError, setStartError] = useState("");

  const s = useDance();
  const bootDone = useGame((g) => g.bootDone);
  const entered = useGame((g) => g.entered);
  const menuOpen = useGame((g) => g.menuOpen);

  // One player for the life of the panel.
  if (!playerRef.current) playerRef.current = new DancePlayer(gameApi);
  const player = playerRef.current;

  // The media handle the stage registers its <video> with. For the
  // built-in routine there is no element, so a synthetic clock stands in
  // and playback code stays identical either way.
  const media = useMemo(() => ({
    register(el) {
      videoRef.current = el;
      player.attach(el);
    },
  }), [player]);

  useEffect(() => {
    if (!s.isDemo) {
      clockRef.current?.dispose();
      clockRef.current = null;
      return;
    }
    const clock = new SyntheticClock(s.duration);
    let lastMirror = 0;
    clock.onTime = (t) => {
      // Same reasoning as the player's tick: the clock runs at the
      // control rate, the scrubber does not need to.
      const now = performance.now();
      if (now - lastMirror < 66 && t < s.duration) return;
      lastMirror = now;
      useDance.setState({ currentTime: t });
    };
    clock.onEnded = () => useDance.setState({ playing: false });
    clockRef.current = clock;
    player.attach(clock);
    return () => { clock.dispose(); };
  }, [s.isDemo, s.duration, player]);

  const activeMedia = () => (s.isDemo ? clockRef.current : videoRef.current);

  // Hand the track to the player whenever the analysis or the tuning
  // changes, so a slider moved mid-playback takes effect on the next step
  // rather than after a restart.
  useEffect(() => {
    if (s.track) player.setTrack(s.track, s.events, s.beats);
  }, [s.track, s.events, s.beats, player]);

  useEffect(() => { player.setOptions(s.playback); }, [s.playback, player]);

  // Push the speed onto the media itself. preservesPitch keeps a slowed
  // clip listenable: without it the music drops a fifth at half speed and
  // the routine stops reading as a dance to that song.
  useEffect(() => {
    const m = s.isDemo ? clockRef.current : videoRef.current;
    if (!m) return;
    m.playbackRate = s.playback.rate;
    if ("preservesPitch" in m) m.preservesPitch = true;
  }, [s.playback.rate, s.isDemo, s.videoUrl, s.duration]);

  useEffect(() => {
    // The player steps 50 times a second. Mirroring every one of those
    // into the store would re-render this whole panel at the control
    // rate, for meters the eye reads perfectly well at 15 Hz.
    let lastMirror = 0;
    player.onTick = ({ t, row, status }) => {
      const now = performance.now();
      if (now - lastMirror < 66) return;
      lastMirror = now;
      useDance.setState({
        currentTime: s.isDemo ? useDance.getState().currentTime : t,
        liveRow: row ? Array.from(row) : null,
        liveStatus: status,
      });
    };
    player.onEvent = (e) => {
      const log = [...useDance.getState().eventLog, e].slice(-8);
      useDance.setState({ eventLog: log });
    };
  }, [player, s.isDemo]);

  // Keep the real video element's own clock mirrored into the store, so
  // the overlay and timeline follow even when the player is not running.
  useEffect(() => {
    const v = videoRef.current;
    if (!v || s.isDemo) return;
    const onTime = () => useDance.setState({ currentTime: v.currentTime });
    const onEnd = () => useDance.setState({ playing: false });
    v.addEventListener("timeupdate", onTime);
    v.addEventListener("seeking", onTime);
    v.addEventListener("ended", onEnd);
    return () => {
      v.removeEventListener("timeupdate", onTime);
      v.removeEventListener("seeking", onTime);
      v.removeEventListener("ended", onEnd);
    };
  }, [s.videoUrl, s.isDemo]);

  useEffect(() => () => player.stop(), [player]);

  const pickFile = (file) => {
    if (!file) return;
    stopPlayback();
    analyseFile(file);
  };

  const stopPlayback = useCallback(() => {
    player.stop();
    activeMedia()?.pause?.();
    useDance.setState({ playing: false });
  }, [player]);

  const togglePlay = useCallback(async () => {
    const m = activeMedia();
    if (!m || !s.track) return;
    if (useDance.getState().playing) {
      stopPlayback();
      return;
    }
    // The duck is behind the title card, the BIOS readout and the
    // entrance animation until someone walks it in. Play does that, then
    // WAITS: rolling the video while the duck is still off stage would
    // start the routine somewhere in its second bar.
    if (!entered) {
      closeMenu();
      useDance.setState({ waitingForDuck: true });
      // A cold boot streams MuJoCo, seven ONNX policies and the meshes
      // before the entrance can even start, so this has to be generous.
      const arrived = await waitForDuck(45000);
      useDance.setState({ waitingForDuck: false });
      if (!arrived) {
        setStartError("The simulator did not finish booting. Reload and try again.");
        return;
      }
      setStartError("");
      // The button may have been pressed again while we waited.
      if (useDance.getState().playing) return;
    }
    m.play?.();
    player.start();
    useDance.setState({ playing: true });
  }, [s.track, entered, player, stopPlayback]);

  const seek = useCallback((t) => {
    const m = activeMedia();
    if (!m) return;
    m.currentTime = Math.max(0, Math.min(s.duration, t));
    useDance.setState({ currentTime: m.currentTime });
  }, [s.duration]);

  const busy = s.stage === "loading" || s.stage === "tracking" ||
    s.stage === "audio" || s.stage === "building";
  const ready = s.stage === "ready" && !!s.track;
  const live = s.liveRow;

  return (
    <Box
      onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        pickFile(e.dataTransfer.files?.[0]);
      }}
      sx={{
        height: "100%", overflowY: "auto", overflowX: "hidden",
        px: 2, pb: 3, pt: 1.5,
        background: dragging ? "rgba(255,122,47,0.10)" : "transparent",
        transition: "background 140ms",
        scrollbarWidth: "thin",
        scrollbarColor: "rgba(255,255,255,0.2) transparent",
      }}
    >
      <Box sx={{ display: "flex", alignItems: "baseline", gap: 1 }}>
        <Box sx={{ fontFamily: ANTON, fontSize: "1.5rem", color: CREAM,
          letterSpacing: "0.02em", textTransform: "uppercase" }}>
          Duck<Box component="span" sx={{ color: COMIC_ORANGE }}>Dance</Box>
        </Box>
        <Box sx={{ fontFamily: MONO, fontSize: "0.6rem",
          color: "rgba(255,255,255,0.4)" }}>
          teach it a routine from a video
        </Box>
      </Box>

      {/* ── Source ─────────────────────────────────────────────────── */}
      <Panel title="1. The video" right={s.fileName || undefined}>
        <Row>
          <ComicButton size="xs" scheme="orange" onDark
            onClick={() => fileRef.current?.click()}>
            Choose a video
          </ComicButton>
          <ComicButton size="xs" scheme="paper" variant="outline" onDark
            onClick={() => { stopPlayback(); loadDemo(); }}>
            Use the built-in routine
          </ComicButton>
          {(ready || s.stage === "error") && (
            <ComicButton size="xs" scheme="paper" variant="outline" onDark
              onClick={() => { stopPlayback(); reset(); }}>
              Clear
            </ComicButton>
          )}
          {busy && (
            <ComicButton size="xs" scheme="paper" variant="outline" onDark
              onClick={cancelAnalysis}>
              Stop
            </ComicButton>
          )}
        </Row>
        <Box component="input" ref={fileRef} type="file" accept="video/*"
          onChange={(e) => pickFile(e.target.files?.[0])}
          sx={{ display: "none" }} />

        {busy && (
          <Box sx={{ mt: 1.2 }}>
            <Box sx={{ height: 6, background: "rgba(255,255,255,0.08)",
              border: "1px solid rgba(255,255,255,0.14)" }}>
              <Box sx={{ height: "100%", width: `${s.progress * 100}%`,
                background: COMIC_ORANGE, transition: "width 160ms" }} />
            </Box>
            <Note>{s.progressLabel}</Note>
          </Box>
        )}
        {s.stage === "error" && <Note tone="bad">Could not use this clip: {s.error}</Note>}
        {s.stage === "idle" && (
          <Note>
            Drop a clip anywhere in this panel. It is analysed on your machine
            and never uploaded. One dancer, full body in frame, works best.
          </Note>
        )}
        {ready && (
          <Note tone={s.trackedFraction < 0.7 ? "warn" : "dim"}>
            {Math.round(s.trackedFraction * 100)}% of frames tracked
            {s.bpm ? `, ${s.bpm.toFixed(1)} BPM` : ", no beat found"}
            {s.captureInfo?.mode === "seek" ? ", stepped frame by frame" : ""}
            {s.trackedFraction < 0.7 && " — the duck will be vague where the dancer was lost."}
          </Note>
        )}
      </Panel>

      {/* ── Stage ──────────────────────────────────────────────────── */}
      <Panel title="2. The dancer" accent={ACID_CYAN}
        right={ready ? `${s.frames?.length ?? 0} frames` : undefined}>
        <Stage media={media} onSeek={seek} onTogglePlay={togglePlay} />
        {!bootDone && (
          <Note tone="warn">The simulator on the right is still booting.</Note>
        )}
        {s.waitingForDuck && (
          <Note tone="warn">Walking the duck in, the routine starts when it lands.</Note>
        )}
        {startError && <Note tone="bad">{startError}</Note>}
        {bootDone && menuOpen && !entered && !s.waitingForDuck && (
          <Note>Press play and the duck will walk in by itself.</Note>
        )}
      </Panel>

      {/* ── Speed ──────────────────────────────────────────────────── */}
      {ready && s.track?.fit && (
        <Panel title="3. Speed" accent={COMIC_YELLOW}
          right={`duck needs ${s.track.fit.demand.toFixed(1)}x longer`}>
          <Row gap={0.6}>
            {[1, 0.75, 0.5, 0.35].map((r) => (
              <Box key={r} onClick={() => setPlayback({ rate: r })}
                sx={{ cursor: "pointer", fontFamily: MONO, fontSize: "0.62rem",
                  px: 1, py: 0.35,
                  border: `2px solid ${s.playback.rate === r ? COMIC_ORANGE : "rgba(255,255,255,0.22)"}`,
                  color: s.playback.rate === r ? COMIC_INK : "rgba(255,255,255,0.72)",
                  background: s.playback.rate === r ? COMIC_ORANGE : "transparent" }}>
                {r === 1 ? "full speed" : `${r}x`}
              </Box>
            ))}
            <ComicButton size="xs" scheme="paper" variant="outline" onDark
              onClick={() => setPlayback({ rate: s.track.fit.recommendedRate })}>
              Fit to the duck
            </ComicButton>
          </Row>
          {s.track.fit.demand > 1.15 ? (
            <Note tone={s.playback.rate <= s.track.fit.recommendedRate ? "dim" : "warn"}>
              This dancer moves about {s.track.fit.demand.toFixed(1)} times faster
              than the duck can follow, worst on {s.track.fit.limitedBy}. A command
              channel takes roughly 0.4 s to swing from one extreme to the other,
              so at full speed most of the motion is thrown away and what is left
              reads as twitching. {s.track.fit.recommendedRate}x speed gives it room.
            </Note>
          ) : (
            <Note>The duck can follow this one at full speed.</Note>
          )}
        </Panel>
      )}

      {/* ── Command ────────────────────────────────────────────────── */}
      {ready && (
        <Panel title="4. What the duck is told" accent={COMIC_ORANGE}
          right={s.liveStatus ? `mode ${s.liveStatus.mode}` : undefined}>
          <Meter label="forward" value={live?.[CH.VX] ?? 0} range={LIMITS.vxFwd} unit=" m/s" />
          <Meter label="sideways" value={live?.[CH.VY] ?? 0} range={LIMITS.vy} unit=" m/s" />
          <Meter label="turn" value={live?.[CH.WZ] ?? 0} range={LIMITS.wz} unit=" r/s" />
          <Meter label="lean" value={live?.[CH.NECK_PITCH] ?? 0} range={LIMITS.head} unit=" rad" />
          <Meter label="nod" value={live?.[CH.HEAD_PITCH] ?? 0} range={LIMITS.head} unit=" rad" />
          <Meter label="look" value={live?.[CH.HEAD_YAW] ?? 0} range={LIMITS.head} unit=" rad" />
          <Meter label="tilt" value={live?.[CH.HEAD_ROLL] ?? 0} range={LIMITS.head} unit=" rad" />
          <Box sx={{ mt: 1.2 }}><Timeline /></Box>
        </Panel>
      )}

      {/* ── Moves ──────────────────────────────────────────────────── */}
      {ready && (
        <Panel title="5. The moves" right={`${s.events.length} scheduled`}>
          <Row gap={0.6}>
            {s.events.slice(0, 14).map((e, i) => (
              <Box key={i} sx={{
                fontFamily: MONO, fontSize: "0.58rem", px: 0.7, py: 0.15,
                border: "1px solid rgba(255,255,255,0.2)",
                color: "rgba(255,255,255,0.72)",
              }}>
                {e.t.toFixed(1)}s {MOVE_LABEL[e.type] ?? e.type}
                {e.quantised ? " ·" : ""}
              </Box>
            ))}
            {!s.events.length && <Note>No moves found. Raise the sensitivity below.</Note>}
          </Row>
          {s.eventLog.length > 0 && (
            <Box sx={{ mt: 1 }}>
              {s.eventLog.slice(-4).map((e, i) => (
                <Box key={i} sx={{ fontFamily: MONO, fontSize: "0.58rem",
                  color: e.fired ? ACID_CYAN : "rgba(255,255,255,0.35)" }}>
                  {e.t.toFixed(2)}s {MOVE_LABEL[e.type] ?? e.type}
                  {e.fired ? " — performed" : ` — skipped, ${e.reason}`}
                </Box>
              ))}
            </Box>
          )}
        </Panel>
      )}

      {/* ── Tuning ─────────────────────────────────────────────────── */}
      {ready && (
        <Panel title="6. Tuning">
          <Knob label="Turning" value={s.tuning.gainTurn} min={0} max={2} onChange={(v) => setTuning({ gainTurn: v })} />
          <Knob label="Sideways sway" value={s.tuning.gainSway} min={0} max={2} onChange={(v) => setTuning({ gainSway: v })} />
          <Knob label="Stepping" value={s.tuning.gainStride} min={0} max={2} onChange={(v) => setTuning({ gainStride: v })} />
          <Knob label="Head" value={s.tuning.gainHead} min={0} max={2} onChange={(v) => setTuning({ gainHead: v })} />
          <Knob label="Calm" value={s.tuning.smoothing} min={0.4} max={3} onChange={(v) => setTuning({ smoothing: v })}
            hint="higher smooths the duck's command, lower keeps the dancer's detail" />
          <Knob label="Move sensitivity" value={s.moveTuning.sensitivity} min={0.3} max={2.5}
            onChange={(v) => setMoveTuning({ sensitivity: v })}
            hint={`${s.events.length} moves, ${s.rejected.length} dropped as too close together`} />
          <Box sx={{ mt: 1.2 }}>
            <Toggle label="Mirror the dancer" checked={s.tuning.mirror}
              onChange={(v) => { setTuning({ mirror: v }); setMoveTuning({ mirror: v }); }}
              hint="use this if the duck turns the wrong way" />
            <Toggle label="Kicks" checked={s.moveTuning.enableKicks}
              onChange={(v) => setMoveTuning({ enableKicks: v })} />
            <Toggle label="Bow" checked={s.moveTuning.enablePick}
              onChange={(v) => setMoveTuning({ enablePick: v })} />
            <Toggle label="Sit down" checked={s.moveTuning.enableSit}
              onChange={(v) => setMoveTuning({ enableSit: v })} />
            <Toggle label="Roulade" checked={s.moveTuning.enableRoll}
              onChange={(v) => setMoveTuning({ enableRoll: v })}
              hint="a real fall risk, off by default" />
            <Toggle label="Snap moves to the beat" checked={s.moveTuning.quantise}
              onChange={(v) => setMoveTuning({ quantise: v })}
              hint={s.bpm ? `${s.bpm.toFixed(1)} BPM detected` : "no beat detected in this clip"} />
            <Toggle label="Loop the routine" checked={s.playback.loop}
              onChange={(v) => setPlayback({ loop: v })} />
          </Box>

          <Box onClick={() => setShowAdvanced(!showAdvanced)}
            sx={{ mt: 0.6, cursor: "pointer", fontFamily: MONO,
              fontSize: "0.6rem", color: COMIC_ORANGE }}>
            {showAdvanced ? "hide" : "show"} the fiddly ones
          </Box>
          {showAdvanced && (
            <Box sx={{ mt: 1 }}>
              <Knob label="Lead time" value={s.playback.leadTime} min={0} max={0.4} step={0.01}
                onChange={(v) => setPlayback({ leadTime: v })}
                format={(v) => `${(v * 1000).toFixed(0)} ms`}
                hint="how early a move is fired so the motion lands on the beat" />
              <Knob label="Step vs depth" value={s.tuning.strideMix} min={0} max={1}
                onChange={(v) => setTuning({ strideMix: v })}
                hint="how much of the forward command comes from step cadence rather than the dancer walking toward the camera" />
              <Knob label="Lean into neck" value={s.tuning.gainLean} min={0} max={2}
                onChange={(v) => setTuning({ gainLean: v })} />
              <Row gap={0.6}>
                {["signNeckPitch", "signHeadPitch", "signHeadYaw", "signHeadRoll"].map((k) => (
                  <Box key={k} onClick={() => setTuning({ [k]: -s.tuning[k] })}
                    sx={{ cursor: "pointer", fontFamily: MONO, fontSize: "0.58rem",
                      px: 0.7, py: 0.25, border: "1px solid rgba(255,255,255,0.22)",
                      color: s.tuning[k] > 0 ? ACID_CYAN : COMIC_ORANGE }}>
                    {k.replace("sign", "").toLowerCase()} {s.tuning[k] > 0 ? "+" : "−"}
                  </Box>
                ))}
              </Row>
              <Note>Flip a head axis if the duck nods when the dancer shakes.</Note>
            </Box>
          )}
        </Panel>
      )}

      {/* ── Capture settings, only worth touching before an analysis ── */}
      <Panel title="Analysis settings" dense>
        <Row gap={0.6}>
          {["lite", "full"].map((m) => (
            <Box key={m} onClick={() => setCaptureOpts({ model: m })}
              sx={{ cursor: "pointer", fontFamily: MONO, fontSize: "0.6rem",
                px: 0.9, py: 0.3,
                border: `2px solid ${s.captureOpts.model === m ? COMIC_ORANGE : "rgba(255,255,255,0.22)"}`,
                color: s.captureOpts.model === m ? COMIC_INK : "rgba(255,255,255,0.7)",
                background: s.captureOpts.model === m ? COMIC_ORANGE : "transparent" }}>
              {m === "lite" ? "fast model" : "accurate model"}
            </Box>
          ))}
          {["auto", "seek"].map((m) => (
            <Box key={m} onClick={() => setCaptureOpts({ mode: m })}
              sx={{ cursor: "pointer", fontFamily: MONO, fontSize: "0.6rem",
                px: 0.9, py: 0.3,
                border: `2px solid ${s.captureOpts.mode === m ? ACID_CYAN : "rgba(255,255,255,0.22)"}`,
                color: s.captureOpts.mode === m ? COMIC_INK : "rgba(255,255,255,0.7)",
                background: s.captureOpts.mode === m ? ACID_CYAN : "transparent" }}>
              {m === "auto" ? "play through" : "step frame by frame"}
            </Box>
          ))}
        </Row>
        <Note>
          Stepping frame by frame is slower but never drops frames. Changing
          these re-runs the analysis on the next clip you load.
        </Note>
      </Panel>
    </Box>
  );
}
