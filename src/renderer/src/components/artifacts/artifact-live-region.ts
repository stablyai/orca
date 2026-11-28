/** Why: a live region re-reads only when its text changes, so alternate a trailing no-break space to
 * repeat an identical message (the same count after a different check, a second equal batch). */
export function liveRegionNonce(seq: number): string {
  return seq % 2 === 1 ? '\u00a0' : ''
}
