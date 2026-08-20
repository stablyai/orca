/** Below this, red and blue do not dominate green enough to be the key colour —
 *  it is a purple or a pink from the sprite art, and must survive. */
const MIN_DOMINANCE = 0.4

/** How magenta a pixel is, from 0 (leave it) to 1 (key it out).
 *
 *  WebP and JPEG smear the magenta key into wide gradient halos, so a plain RGB
 *  distance leaves fringing. This is a hue-style test instead: the magenta
 *  family has red and blue far above green.
 *
 *  The score is normalised across the band ABOVE the threshold, which is what
 *  makes a partial score possible at all. The previous form multiplied the raw
 *  dominance by 1.4 after requiring it to exceed 0.4, so the smallest score it
 *  could return was 0.56 — every pixel it scored was hard-cleared, and the
 *  proportional-alpha path its own comment described was unreachable. */
export function magentaScore(r: number, g: number, b: number): number {
  const minRB = Math.min(r, b)
  if (g >= minRB) {
    return 0
  }
  const dominance = (minRB - g) / 255
  if (dominance <= MIN_DOMINANCE) {
    return 0
  }
  return Math.min(1, (dominance - MIN_DOMINANCE) / (1 - MIN_DOMINANCE))
}

/** Clears the key colour, fading the halo rather than cutting a hard edge. */
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
      continue
    }
    px[i + 3] = Math.round(px[i + 3] * Math.max(0, 1 - score * 2))
  }
}
