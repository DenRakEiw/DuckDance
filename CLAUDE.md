# DuckDance — working notes

Context for anyone (including a future session) picking this up cold. The
README is written for a visitor; this file is written for whoever has to
change the code.

## What this is

A web app: dance video on the left, a Microduck robot dancing to it on the
right. Everything runs in the browser, the video never leaves the machine.

- Repo: https://github.com/DenRakEiw/DuckDance (private), remote `origin`, branch `main`
- Working dir: `F:\Duck`, app lives in `F:\Duck\app`
- The user writes German; replies have been in German.

## Committing

Commits must be authored as
`DenRakEiw <89697885+DenRakEiw@users.noreply.github.com>`. This is set
both globally and in `.git/config`, so nothing needs doing by hand — but
do not "helpfully" fall back to another address if a commit ever refuses
to run.

The reason is not cosmetic. The user's other address,
`gupaiacc@gmail.com`, is registered to a **different** GitHub account,
`imaginegundp`, and GitHub attributes a commit by whichever account owns
the author email. The first six commits here were pushed that way and all
showed up under the wrong name. On 2026-09-03 the history was rewritten
with `git filter-branch --env-filter` and force-pushed; the pre-rewrite
state is on the local branch `backup/pre-identity-rewrite`.

Check attribution against the API, never the repo sidebar:

```bash
gh api repos/DenRakEiw/DuckDance/commits --jq '.[] | .author.login'
gh api repos/DenRakEiw/DuckDance/contributors --jq '.[] | "\(.login) \(.contributions)"'
```

The Contributors box on the repo page is cached server-side: it was still
listing `imaginegundp` after the rewrite while the API already read clean,
and no reload or push clears it. It also counts
co-authors, which is why `claude` appears there: every commit carries a
`Co-Authored-By: Claude Opus 5` trailer. Removing that from the list would
mean another full-history rewrite. The user was asked and has not decided;
do not strip the trailers unless they say so.

## Commands

```bash
cd F:\Duck\app && npm run dev     # http://localhost:5173
cd F:\Duck\app && npm test        # both check suites, no browser needed
cd F:\Duck\app && npm run build
```

`.claude/launch.json` defines a `duckdance` preview server on port 5173.

`?boot=1` skips the title card. `?ghosts=1` re-enables pose broadcasting.
Debug handles in the console: `window.rl` (sim internals, upstream),
`window.__store` (sim UI state, upstream), `window.__gameApi` (upstream +
our `dance` surface), `window.__danceStore` (ours).

## Provenance

`app/` is a fork of the Hugging Face Space
`pollen-robotics/microduck-simulator` at revision `1261013`, cloned into
`upstream-sim/` (gitignored, may not exist in a fresh checkout — re-clone
from the Space if you need to diff).

Upstream code we touched, and only this:

- `src/game/game.js` — registers a `DanceSource` ahead of the other input
  sources, adds `gameApi.dance`, and gates the multiplayer ghosts.
- `src/ui/TitleMenu.jsx` — `closeMenu` exported so the play button can
  walk the duck in.
- `src/main.jsx` — renders `DuckDanceApp` instead of `App`.

Everything else under `src/game/` and `src/ui/` is upstream. Keep it that
way; it makes pulling upstream changes tractable.

## The one thing to understand first

The simulator never poses the duck. It runs a velocity-tracking policy at
50 Hz whose entire interface is a 13-slot command vector:

| Slot | Meaning |
| --- | --- |
| 0-2 | vx, vy, wz |
| 3-6 | neck_pitch, head_pitch, head_yaw, head_roll |
| 7-12 | body pose — **the sandbox's policies never read these**, always zero |

So "make it dance" means writing a plausible twist and head pose every
20 ms. The legs are the policy's business. There is no keyframe track and
there cannot be one without training a new policy.

Limits, from the sandbox's own `constants.js` (its keyboard uses the same):
`vx` +0.25/-0.2 m/s, `vy` ±0.15, `wz` ±1.0 rad/s. Head limit ±0.9 rad is
ours; the runtime allows 2.5, which looks like a broken neck.

Slew caps per 20 ms step: vx 0.02, vy 0.015, wz 0.10, head 0.09. **These
drive every design decision below.** A full swing takes about 0.4 s, and a
beat at 125 BPM is 0.48 s.

## Architecture

```
video ──► capture ──► features ──► retarget | phrase ──► track ──► player ──► DanceSource ──► sim
                          │                                          ▲
                          └──► moves ──► scheduled skills ───────────┘
audio ──► beat ──► tempo, beat grid ──────────────────────────────────┘
```

`src/dance/`:

| File | Role |
| --- | --- |
| `capture.js` | MediaPipe over the video; playback path with automatic fallback to frame stepping |
| `stamp.js` | Strictly rising detector timestamps, per landmarker rather than per clip |
| `features.js` | Landmarks → body basis, head angles, limb and posture signals. **Raw and uncentred.** |
| `retarget.js` | Direct path: every frame → a command, rate limiter discards the rest |
| `phrase.js` | Phrased path (**the default**): builds a command that fits by construction |
| `moves.js` | Kick / bow / sit detection and budget-aware scheduling |
| `beat.js` | Spectral flux onsets → tempo → beat grid. Pure, testable under node. |
| `player.js` | Video time in, duck commands out |
| `clock.js` | Stand-in for a video element, for the built-in routine |
| `DanceSource.js` | Presents all of it to the sim as one more input device |
| `synth.js` | Synthetic dancer: the test fixture **and** the built-in demo |
| `store.js` | Zustand store + the analysis orchestration |
| `draw.js`, `ui/` | Skeleton overlay and the left panel |

## Traps that already cost time

**Handedness.** `synth.js` authors poses in a human frame (X right, Y up,
Z forward) which is **left-handed**. MediaPipe's world frame (x image
right, y image DOWN, z away from lens) is right-handed. The map between
them is a point reflection, so right-hand-rule intuition inverts silently
on the way across. This produced three inverted angles that all looked
plausible. `tools/check-features.mjs` exists to catch exactly this — run it
after touching any geometry.

Sign conventions everything else assumes: **positive is toward the
dancer's own left**, for body yaw, head yaw and head roll. Head pitch
positive is chin up. `leanFwd` positive is bowing toward the lens.

**The tracker's clock outlives the clip.** MediaPipe's VIDEO mode wants
timestamps that rise for the lifetime of the *landmarker*, and the store
keeps one landmarker for the whole session because building it is
expensive. A second clip whose stamps start again near zero does not get
its frames skipped: every `detectForVideo` throws `Packet timestamp
mismatch ... minimum expected timestamp is 40000001 but received 0`, the
capture loop counted that as a frame without a dancer, and the user was
told "no dancer found (0% of frames)" about a clip that was fine. The
seek fallback hit the same wall inside a single run, because it restarts
the same video from the top after playback has reached the end. The floor
now lives with the landmarker (`stamp.js`) and each run picks up above
it, offset so the gaps between frames stay as the video had them.
Detector errors are counted apart from missing detections, so this class
of failure says it is ours rather than blaming the footage.

**Never normalise one limb by a shared scale.** Limb signals divide by
`torsoLen`, not by leg length: the torso holds still while limbs move, so
it is the only stable ruler. Using average leg length made one raised foot
drag the other foot's reading with it.

**Features are raw; calibration is separate.** A planted foot sits around
-1.8 torso lengths below the hip and that number encodes the dancer's
build. `calibrate()` in `retarget.js` subtracts a per-clip baseline. Do not
hard-code human proportions into `features.js`.

**Anything derived from a lost dancer must fade to neutral**, head
included. An early version faded only the twist, and a clip with two stray
detections had the duck holding a contorted head pose for the whole song.

**Timer pacing, not rAF.** The sim's control loop is timer-paced at 50 Hz.
`player.js` and `clock.js` match it. Frame pacing would have coarsened the
dance on any machine rendering below 50 fps while the physics ran on.

**The head is not a phrase-rate channel.** Binding it to the phrase grid
aliased catastrophically: the demo dancer's head swings once per phrase,
every sample landed on the same side, and both channels froze at their
limit. `renderHead()` runs it on the dancer's own clock.

## The two retargeting paths

`tuning.mode` selects; `"phrase"` is the default.

**Direct** (`retarget.js`) maps every frame and lets the slew limiter sort
it out. Faithful on a slow clip. On a 125 BPM phone clip it was clipping
92% of control steps, i.e. discarding nine tenths of the choreography.

**Phrased** (`phrase.js`) summarises the dancer over spans of whole beats
long enough to complete a gesture in (about 1 s, so 2 beats at 125 BPM),
gives each span one target per channel, and smoothsteps between them. A
smoothstep's peak slope is a known 1.5× the average, which makes the slew
cap a budget that can be checked in advance: a target that will not fit is
shrunk, so the duck performs a smaller **complete** gesture rather than
being cut off. Head runs separately at the dancer's own rate, smoothed
only as far as needed to buy a visible amplitude, then scaled to fit.

Measured on the same clip: phrased sits at exactly 1.000× the limit with
nothing discarded; body direction changes drop 89 → 13; head keeps 41 of
42.

`sustainedCeiling` (0.8) exists because the phrased path **holds** targets
where the direct path only spikes. Holding a turn near the policy limit
for two thirds of a second is what put the duck on the floor.

## Moves

Occupancy costs, from the sandbox's own step budgets: kick 1.1 s, pick
3.2 s, sit 1.2 s + stand 2.4 s, roll 2.5 s. A skill freezes the twist, so
this is time not spent dancing.

Two fixes worth remembering. Kick thresholds were anchored **above**
everything the dancer ever did (a high percentile × 1.35), so on a busy
clip not one kick fired; they now sit between the typical lift and the
biggest one, and are reachable by construction. Scheduling was greedy in
time order, so six squats ate half a song; candidates now compete on value
per occupied second against a budget (20% of the routine), and a sit is
priced together with the stand that ends it.

## Decisions, and why

- **Pose broadcasting off by default.** Upstream shows other visitors as
  translucent ducks over public Nostr relays. There the broadcast pose is
  someone using arrow keys; here it is derived from a video the user chose
  off their own machine, and the app promises it stays local. `?ghosts=1`.
- **Clips below 15% tracked are rejected**, not turned into a routine
  built on noise.
- **Local MediaPipe.** wasm and both `.task` models are vendored under
  `app/public/mediapipe`, so analysis needs no network. MuJoCo and
  onnxruntime still come from a CDN (upstream's choice).

## Testing

`tools/check-features.mjs` (31 checks) pins the sign conventions using the
synthetic dancer. `tools/check-pipeline.mjs` (52 checks) covers the track
staying inside the policy limits, the slew limiter, phrased output fitting
by construction, move scheduling and budget, the beat analyser against a
synthetic click track, and the capture timestamps rising across clips. Both run under node; no browser, no video.

The browser pane in this environment throttles rAF hard, so the sim's
render loop and the entrance ceremony only advance while screenshots force
composites. Physics and the dance player are timer-paced and unaffected.
Expect UI clicks to need exact coordinates (the tool's frame is half the
CSS pixel size at 1600×950) or to be driven from JS.

## State

Verified: the analysis chain end to end; commands inside the policy's
limits; the duck dancing to the built-in routine; kicks firing through the
sandbox's skills and being refused while it is busy; tempo from a real MP4
to within 0.1%; a real 44 s phone clip tracked 100% at 125.7 BPM; a clip
with no dancer failing cleanly.

Not verified: the phrased path against real footage. That is the next
thing to do, and the comparison to ask the user for is phrased vs frame by
frame on their own clip.

Open:

- The duck still goes over about three times in the 24 s demo, nearly
  always around a kick. Upstream calls its kicks blind one-shot boots.
  Turning kicks off makes the routine stable.
- The beat grid is a constant tempo and will not follow a clip that
  changes speed.
- Depth from one camera is weak; forward motion leans on step cadence.
- The duck has no arms, so most upper-body dance is redirected into the
  head and neck.

The bigger prize, unstarted: a genuine imitation policy trained in
`pollen-robotics/microduck_rl` against reference motions retargeted from
video would drive all 14 joints. This repo already produces the retargeted
reference motion such a policy would need.
