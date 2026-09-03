// BlazePose 33-point topology, as emitted by MediaPipe's Pose Landmarker.
// Names are ANATOMICAL: LEFT_SHOULDER is the dancer's own left, which
// lands on the RIGHT half of an unmirrored frame when they face the lens.

export const LM = {
  NOSE: 0,
  EYE_INNER_L: 1, EYE_L: 2, EYE_OUTER_L: 3,
  EYE_INNER_R: 4, EYE_R: 5, EYE_OUTER_R: 6,
  EAR_L: 7, EAR_R: 8,
  MOUTH_L: 9, MOUTH_R: 10,
  SHOULDER_L: 11, SHOULDER_R: 12,
  ELBOW_L: 13, ELBOW_R: 14,
  WRIST_L: 15, WRIST_R: 16,
  PINKY_L: 17, PINKY_R: 18,
  INDEX_L: 19, INDEX_R: 20,
  THUMB_L: 21, THUMB_R: 22,
  HIP_L: 23, HIP_R: 24,
  KNEE_L: 25, KNEE_R: 26,
  ANKLE_L: 27, ANKLE_R: 28,
  HEEL_L: 29, HEEL_R: 30,
  FOOT_L: 31, FOOT_R: 32,
};

// Bone list for the skeleton overlay drawn on the video.
export const BONES = [
  [LM.SHOULDER_L, LM.SHOULDER_R], [LM.SHOULDER_L, LM.HIP_L],
  [LM.SHOULDER_R, LM.HIP_R], [LM.HIP_L, LM.HIP_R],
  [LM.SHOULDER_L, LM.ELBOW_L], [LM.ELBOW_L, LM.WRIST_L],
  [LM.SHOULDER_R, LM.ELBOW_R], [LM.ELBOW_R, LM.WRIST_R],
  [LM.HIP_L, LM.KNEE_L], [LM.KNEE_L, LM.ANKLE_L], [LM.ANKLE_L, LM.FOOT_L],
  [LM.HIP_R, LM.KNEE_R], [LM.KNEE_R, LM.ANKLE_R], [LM.ANKLE_R, LM.FOOT_R],
  [LM.NOSE, LM.EAR_L], [LM.NOSE, LM.EAR_R],
];

// Joints whose frame-to-frame travel feeds the motion-energy signal.
export const ENERGY_POINTS = [
  LM.WRIST_L, LM.WRIST_R, LM.ELBOW_L, LM.ELBOW_R,
  LM.ANKLE_L, LM.ANKLE_R, LM.KNEE_L, LM.KNEE_R,
  LM.SHOULDER_L, LM.SHOULDER_R, LM.NOSE,
];

// Points that must be tracked for a frame to be usable at all.
export const CORE_POINTS = [LM.SHOULDER_L, LM.SHOULDER_R, LM.HIP_L, LM.HIP_R];
