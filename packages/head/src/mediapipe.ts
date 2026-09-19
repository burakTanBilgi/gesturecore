import type { Landmark } from 'gesturecore';
import type { Face } from './types.js';

/**
 * The part of a MediaPipe `FaceLandmarkerResult` the reader needs, described by shape so
 * this package does not depend on MediaPipe.
 */
export type FaceLandmarkerResultLike = {
  faceLandmarks: readonly (readonly Landmark[])[];
  faceBlendshapes?: readonly { categories: readonly { categoryName: string; score: number }[] }[];
};

/**
 * The `index`-th face of a Face Landmarker result, or `null` when there is none. Create
 * the landmarker with `outputFaceBlendshapes: true` to read brows, frown, mouth and smile.
 */
export function faceFromMediaPipe(result: FaceLandmarkerResultLike, index = 0): Face | null {
  const landmarks = result.faceLandmarks[index];
  if (!landmarks) return null;
  const categories = result.faceBlendshapes?.[index]?.categories;
  if (!categories) return { landmarks };
  const blendshapes: Record<string, number> = {};
  for (const c of categories) if (c.categoryName !== '_neutral') blendshapes[c.categoryName] = c.score;
  return { landmarks, blendshapes };
}
