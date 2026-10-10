import type { TerminalTab } from '../terminal-tab-types'

/** The lowest free "Terminal N", so a fresh terminal is "Terminal 1" again after older tabs close. */
export function getNextTerminalOrdinal(
  tabs: readonly Pick<TerminalTab, 'defaultTitle' | 'title'>[]
): number {
  const usedOrdinals = new Set<number>()
  for (const tab of tabs) {
    const match = /^Terminal (\d+)$/.exec(tab.defaultTitle ?? tab.title)
    if (!match) {
      continue
    }
    usedOrdinals.add(Number(match[1]))
  }
  let nextOrdinal = 1
  while (usedOrdinals.has(nextOrdinal)) {
    nextOrdinal += 1
  }
  return nextOrdinal
}
