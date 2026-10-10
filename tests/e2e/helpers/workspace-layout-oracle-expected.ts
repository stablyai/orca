/**
 * The layout a step's commands should produce, checked against the runtime: panes per tab, which
 * panes are gone, and that every other pane still shows the terminal it showed before the step.
 */

import type { OracleLayout, OracleTerminalTab } from './workspace-layout-oracle-model'

export type ExpectedLayout = {
  worktreeId: string
  /** Panes per terminal tab, in tab order. */
  panesPerTab: number[]
  /** Panes the step removes: their leaf ids, or how many when the ids are not known up front. */
  removed?: string[] | number
  /** The step legitimately restarts terminals (daemon restart, cold relaunch, wake). */
  terminalsRestart?: true
}

function worktreeTabs(layout: OracleLayout, worktreeId: string): OracleTerminalTab[] | null {
  const entry = Object.entries(layout).find(([key]) => key.endsWith(`|${worktreeId}`))
  return entry ? entry[1].terminalTabs : null
}

export function expectedDifferences(
  layout: OracleLayout,
  expected: ExpectedLayout,
  previous: OracleLayout | null
): string[] {
  const id = expected.worktreeId
  const tabs = worktreeTabs(layout, id)
  // No empty passes: the expected tabs must exist before anything else is compared.
  if (!tabs || tabs.length === 0) {
    if (expected.panesPerTab.length === 0) {
      return []
    }
    return [
      `${id}: the runtime holds no terminal tabs, expected ${JSON.stringify(expected.panesPerTab)}`
    ]
  }
  const differences: string[] = []
  const actual = tabs.map((tab) => tab.panes.length)
  if (JSON.stringify(actual) !== JSON.stringify(expected.panesPerTab)) {
    differences.push(
      `${id}: panes per tab ${JSON.stringify(actual)}, expected ${JSON.stringify(expected.panesPerTab)}`
    )
  }
  const before = previous ? worktreeTabs(previous, id) : null
  if (!before) {
    return differences
  }
  const now = new Map(tabs.flatMap((tab) => tab.panes.map((pane) => [pane.leafId, pane.ptyId])))
  const gone = before.flatMap((tab) => tab.panes).filter((pane) => !now.has(pane.leafId))
  const removed = expected.removed ?? 0
  if (typeof removed === 'number') {
    if (gone.length !== removed) {
      differences.push(
        `${id}: ${gone.length} pane(s) gone (${gone.map((pane) => pane.leafId).join(', ')}), expected ${removed}`
      )
    }
  } else {
    const wrong = gone.filter((pane) => !removed.includes(pane.leafId)).map((pane) => pane.leafId)
    const kept = removed.filter((leafId) => now.has(leafId))
    if (wrong.length > 0 || kept.length > 0) {
      differences.push(
        `${id}: removed the wrong pane(s); gone [${wrong.join(', ')}], should be gone [${kept.join(', ')}]`
      )
    }
  }
  if (!expected.terminalsRestart) {
    for (const pane of before.flatMap((tab) => tab.panes)) {
      const ptyId = now.get(pane.leafId)
      if (ptyId !== undefined && pane.ptyId && ptyId !== pane.ptyId) {
        differences.push(`${id}: pane ${pane.leafId} switched terminal ${pane.ptyId} → ${ptyId}`)
      }
    }
  }
  const unbound = tabs.flatMap((tab) => tab.panes).filter((pane) => !pane.ptyId)
  if (unbound.length > 0) {
    differences.push(
      `${id}: pane(s) with no terminal: ${unbound.map((pane) => pane.leafId).join(', ')}`
    )
  }
  return differences
}
