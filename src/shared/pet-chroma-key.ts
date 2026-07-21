/**
 * Magenta chroma key for pet spritesheets.
 *
 * Shared because THREE consumers must key pixels identically: the desktop
 * renderer at runtime, the build-time frame-manifest generator, and any future
 * tooling. If the key differed by a pixel, detected frame rectangles would
 * differ, and the phone would crop sprites at the wrong offsets.
 *
 * Why a hue test rather than RGB distance: WebP/JPEG compression leaves wide
 * gradient halos around each sprite, so a tight distance check leaves ugly
 * fringing. The magenta family has R and B much greater than G. Anything
 * matching gets fully cleared; anything close gets proportional alpha so
 * antialiased edges fade smoothly.
 */

/** 0 = not magenta, 1 = pure magenta key. Restricted to near-pure magenta
 *  (saturated R+B, very low G) so legitimate purples and pinks (128,0,128 or
 *  255,128,200) are not keyed out of imported sprite art. */
export function magentaScore(r: number, g: number, b: number): number {
  const minRB = Math.min(r, b)
  if (g >= minRB) {
    return 0
  }
  const dom = (minRB - g) / 255
  // Require strong R+B dominance over G so purples/pinks survive, while
  // antialiased edge pixels (255,128,255 -> dom~0.5) still fade.
  if (dom <= 0.4) {
    return 0
  }
  return Math.max(0, Math.min(1, dom * 1.4))
}

/** Clear keyed pixels in place, fading partial matches. */
export function keyMagenta(px: Uint8ClampedArray): void {
  for (let i = 0; i < px.length; i += 4) {
    const score = magentaScore(px[i], px[i + 1], px[i + 2])
    if (score <= 0) {
      continue
    }
    if (score >= 0.5) {
      px[i + 3] = 0
      px[i] = 0
      px[i + 1] = 0
      px[i + 2] = 0
    } else {
      const keep = 1 - score * 2
      px[i + 3] = Math.round(px[i + 3] * Math.max(0, keep))
    }
  }
}
