/** How tall the open roster may draw: a few rows, plus the lead row's question so the compact rows
 *  below it still show, kept inside a joined dock's share of the chat pane. */
export function workerDockRosterBudget(
  root: HTMLElement | null,
  viewport: HTMLElement,
  narrow: boolean,
  orderHeld: boolean
): number {
  const pane = root?.closest('[data-native-chat-root]')?.getBoundingClientRect()
  const paneHeight = pane?.height ?? globalThis.innerHeight
  const short = paneHeight < 520
  const lead = viewport.querySelector<HTMLElement>('[data-worker-dock-lead]')?.offsetHeight ?? 0
  const leadExtra = Math.max(0, lead - (narrow ? 64 : 40))
  const nominal = (narrow ? (short ? 120 : 200) : short ? 100 : 160) + leadExtra
  if (!root?.closest('[data-native-chat-worker-dock]')) {
    return nominal
  }
  const cap = Math.max(44, Math.min(paneHeight * 0.4, paneHeight - 180))
  return Math.min(nominal, Math.max(0, cap - (narrow ? 44 : 32) - 24 - (orderHeld ? 28 : 0)))
}
