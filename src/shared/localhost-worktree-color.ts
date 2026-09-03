// Why: the favicon served by the label proxy and the renderer's port
// indicators must derive the identical color from a label, so a browser tab
// can be matched to its Orca worktree by color alone.

// Why: a fixed 12-hue wheel keeps neighboring labels visually distinct;
// raw hash-derived hues cluster into near-identical muddy colors.
const HUE_COUNT = 12
const HUE_STEP = 360 / HUE_COUNT

export const LOCALHOST_WORKTREE_COLOR_SATURATION = 0.68
export const LOCALHOST_WORKTREE_COLOR_LIGHTNESS = 0.46

export function getLocalhostWorktreeHue(label: string): number {
  return (fnv1aHash(label) % HUE_COUNT) * HUE_STEP
}

export function getLocalhostWorktreeCssColor(label: string): string {
  const saturation = Math.round(LOCALHOST_WORKTREE_COLOR_SATURATION * 100)
  const lightness = Math.round(LOCALHOST_WORKTREE_COLOR_LIGHTNESS * 100)
  return `hsl(${getLocalhostWorktreeHue(label)} ${saturation}% ${lightness}%)`
}

function fnv1aHash(value: string): number {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash
}
