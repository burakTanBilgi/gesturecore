/**
 * Face Mesh landmark indices the reader uses, with their positions on MediaPipe's
 * canonical face model (mediapipe/modules/face_geometry/data/canonical_face_model.obj,
 * Apache-2.0). That model is a mean face looking straight down +z, with +y up and +x
 * toward the face's own left; reading it gives yaw, pitch and roll of exactly zero.
 */

/** [x, y, z] in the model's units (centimetres). */
type Vertex = readonly [number, number, number];

/**
 * Points that stay put when the face moves: the forehead, the nose, the eye corners and
 * the sides of the face. No lips, brows, lids or jaw, so an expression cannot tilt the
 * head estimate.
 */
export const ANCHORS: ReadonlyMap<number, Vertex> = new Map<number, Vertex>([
  [1, [0, -1.126865, 7.475604]], // nose tip
  [4, [0, -0.46317, 7.58658]],
  [5, [0, 0.365669, 7.24287]],
  [195, [0, 1.059413, 6.774605]],
  [6, [0, 2.473255, 5.788627]], // nose bridge
  [168, [0, 3.271027, 5.236015]],
  [9, [0, 4.885979, 5.385258]],
  [151, [0, 6.54539, 5.027311]],
  [10, [0, 8.261778, 4.481535]], // top of the forehead
  [98, [-1.405627, -1.714196, 5.241087]], // nostrils
  [327, [1.405627, -1.714196, 5.241087]],
  [33, [-4.445859, 2.663991, 3.173422]], // right eye, outer corner
  [133, [-1.856432, 2.585245, 3.757904]], // right eye, inner corner
  [362, [1.856432, 2.585245, 3.757904]], // left eye, inner corner
  [263, [4.445859, 2.663991, 3.173422]], // left eye, outer corner
  [127, [-7.743095, 2.364999, -2.005167]], // temples
  [356, [7.743095, 2.364999, -2.005167]],
  [234, [-7.664182, 0.673132, -2.435867]], // sides of the face
  [454, [7.664182, 0.673132, -2.435867]],
]);

/**
 * The six points of each eye for the eye aspect ratio (Soukupová and Čech, 2016):
 * corners, then two upper-lid points, then the two lower-lid points below them.
 * "Right" and "left" are the face's own, whichever way the frame is mirrored.
 */
export const EYES = {
  right: { corners: [33, 133], upper: [160, 158], lower: [144, 153] },
  left: { corners: [263, 362], upper: [387, 385], lower: [373, 380] },
} as const;

/** Every index read, so a face with fewer landmarks is rejected up front. */
export const HIGHEST_INDEX = 454;
