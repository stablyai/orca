import type { DetectedFrame } from './sprite-frame-detection'

export type DetectedSpriteCacheEntry = {
  frames: DetectedFrame[]
  /** Per-frame image bitmaps drawn from the keyed canvas. */
  bitmaps: ImageBitmap[]
  /** Manifest playback speed; the overlay defaults to 8 fps when absent. */
  fps: number
}
