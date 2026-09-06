import { forEachLivePaneForDesyncSentinel } from '@/lib/pane-manager/pane-manager-registry'

type ProbeDisposable = { dispose: () => void }

type TerminalLike = {
  cols?: number
  rows?: number
  element?: HTMLElement | null
  buffer?: { active?: { type?: string; length?: number } }
  write?: (data: string | Uint8Array, callback?: () => void) => void
  onData?: (listener: (data: string) => void) => ProbeDisposable
  onWriteParsed?: (listener: () => void) => ProbeDisposable
  onRender?: (listener: () => void) => ProbeDisposable
}

export type ProbePane = {
  id?: number
  terminal?: TerminalLike
  container?: HTMLElement
  leafId?: string
}

export function listProbePanes(): ProbePane[] {
  const panes: ProbePane[] = []
  try {
    forEachLivePaneForDesyncSentinel((_key, pane) => {
      panes.push(pane as ProbePane)
    })
  } catch {
    // Why: a mid-teardown manager must not prevent the probe from starting.
  }
  return panes
}

export function paneRootElement(pane: ProbePane | null): HTMLElement | null {
  return pane?.container ?? pane?.terminal?.element ?? null
}

export function findPaneOwningNode<T extends { pane: ProbePane | null }>(
  entries: readonly T[],
  node: Node | null
): T | null {
  if (!node) {
    return null
  }
  return entries.find((entry) => paneRootElement(entry.pane)?.contains(node) === true) ?? null
}

export function findPaneOwningFocus<T extends { pane: ProbePane | null }>(
  entries: readonly T[]
): T | null {
  const focused = typeof document === 'undefined' ? null : document.activeElement
  return findPaneOwningNode(entries, focused)
}
