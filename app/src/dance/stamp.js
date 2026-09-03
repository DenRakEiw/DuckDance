// A strictly increasing millisecond clock for one pose landmarker.
//
// MediaPipe's VIDEO mode runs a graph that accepts monotonic timestamps
// for the lifetime of the LANDMARKER, not of a capture run. Feed it a
// timestamp that does not advance and it does not skip the frame: it
// throws, for that call and every later one below the high-water mark.
//
// A landmarker is expensive to build, so the store keeps one and reuses
// it. That means clip two starts back near 0 ms while the graph's clock
// still stands at the end of clip one, and every detect of the new clip
// throws. Analysing a 40 s clip and then a 30 s one used to report the
// second as "no dancer found (0% of frames)" — the tracker never ran.
// The seek fallback inside a single run hits the same wall: it restarts
// the same video from the top after playback has already reached the end.
//
// So the floor lives with the landmarker. Each run picks up above it and
// offsets the clip's own timestamps, which keeps the gaps between frames
// (all the tracker reads them for) exactly as the video had them.

const floor = new WeakMap();

/**
 * Open a stamp clock for `owner`, continuing above anything an earlier
 * run stamped through it.
 * @param {object} owner  the landmarker this run will feed
 * @returns {(t:number)=>number} video time in seconds → a stamp in ms
 */
export function stampClock(owner) {
  // Resolved at the first stamp, not here: a clock opened before another
  // one has finished with the same landmarker would otherwise snapshot a
  // floor that is already stale by the time it is used.
  let base = null;
  let last = -1;
  return (t) => {
    base ??= (floor.get(owner) ?? -1) + 1;
    const stamp = Math.max(last + 1, base + Math.round(t * 1000));
    last = stamp;
    floor.set(owner, stamp);
    return stamp;
  };
}
