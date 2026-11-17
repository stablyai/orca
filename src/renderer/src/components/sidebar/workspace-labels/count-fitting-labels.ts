const GAP_PX = 4
// shortcut: room for a "+NN" chip; a three-digit count would clip, measure the chip if that ever matters.
const MORE_CHIP_RESERVE_PX = 28

/** How many capsules fit on one line, leaving room for the "+N" chip when some don't. Always at least one. */
export function countFittingLabels(widths: readonly number[], available: number): number {
  let used = 0
  for (let i = 0; i < widths.length; i++) {
    used += (i > 0 ? GAP_PX : 0) + widths[i]
    const chipReserve = i < widths.length - 1 ? GAP_PX + MORE_CHIP_RESERVE_PX : 0
    if (used + chipReserve > available) {
      return Math.max(1, i)
    }
  }
  return widths.length
}
