import { expect, type Page } from '@stablyai/playwright-test'
import { buildFreshShellProbeInputSequence } from '../terminal-probe-input-sequence'
import {
  getTerminalContent,
  resolveActiveTabId,
  type ActivePaneHookDescriptor
} from './terminal-pane-identity'

export async function waitForActivePaneHookDescriptor(
  page: Page,
  timeoutMs = 15_000
): Promise<ActivePaneHookDescriptor> {
  let descriptor: ActivePaneHookDescriptor | null = null
  await expect
    .poll(
      async () => {
        const tabId = await resolveActiveTabId(page)
        if (!tabId) {
          descriptor = null
          return false
        }
        descriptor = await page.evaluate((tabId) => {
          const layoutHasLeaf = (node: unknown, targetLeafId: string): boolean => {
            if (!node || typeof node !== 'object') {
              return false
            }
            const record = node as {
              type?: unknown
              leafId?: unknown
              first?: unknown
              second?: unknown
            }
            if (record.type === 'leaf') {
              return record.leafId === targetLeafId
            }
            return (
              layoutHasLeaf(record.first, targetLeafId) ||
              layoutHasLeaf(record.second, targetLeafId)
            )
          }

          const store = window.__store
          const manager = window.__paneManagers?.get(tabId)
          if (!store || !manager) {
            return null
          }
          const state = store.getState()
          const worktreeId = state.activeWorktreeId
          if (
            !worktreeId ||
            !(state.tabsByWorktree[worktreeId] ?? []).some((tab) => tab.id === tabId)
          ) {
            return null
          }

          const activePane = manager.getActivePane?.() ?? manager.getPanes?.()[0]
          const leafId = activePane?.leafId ?? null
          const layout = state.terminalLayoutsByTabId[tabId]
          if (
            !leafId ||
            !layoutHasLeaf(layout?.root, leafId) ||
            layout?.ptyIdsByLeafId?.[leafId] !== activePane?.container?.dataset?.ptyId
          ) {
            return null
          }
          return { paneKey: `${tabId}:${leafId}`, worktreeId }
        }, tabId)
        return descriptor !== null
      },
      {
        timeout: timeoutMs,
        // Why: hook IPC routing drops statuses for pane keys before the store
        // layout knows that leaf, even if the terminal DOM already has a PTY.
        message: 'Active terminal pane did not become routable for hook status IPC'
      }
    )
    .toBe(true)

  if (!descriptor) {
    throw new Error('Active terminal pane descriptor disappeared after routing wait')
  }
  return descriptor
}

// Why: PTY IDs are opaque integers not exposed in the DOM. Probe each
// candidate with a unique marker and read back via SerializeAddon.
export async function discoverActivePtyId(page: Page): Promise<string> {
  const marker = `__PTY_PROBE_${Date.now()}__`

  const readCandidateIds = async (): Promise<string[]> => {
    const tabId = await resolveActiveTabId(page)
    if (!tabId) {
      return []
    }
    return page.evaluate((tabId) => {
      const store = window.__store
      if (!store) {
        return []
      }
      return store.getState().ptyIdsByTabId[tabId] ?? []
    }, tabId)
  }

  await expect
    .poll(readCandidateIds, {
      timeout: 15_000,
      message: 'discoverActivePtyId: active tab never received PTY candidates'
    })
    .not.toEqual([])

  const candidateIds = await readCandidateIds()

  if (candidateIds.length === 0) {
    // Why: blind-probing arbitrary PTY IDs can write into unrelated shells and
    // hides real regressions in the tab->PTY mapping the test depends on.
    throw new Error('discoverActivePtyId: active tab has no PTY candidates in store')
  }

  const candidateInputs = candidateIds.map((_id, index) =>
    buildFreshShellProbeInputSequence(`echo ${marker}_${index}\r`)
  )

  await page.evaluate(
    ({ candidateIds, candidateInputs }) => {
      // Why: daemon PTY IDs can contain path separators and shell metacharacters.
      // Echo a numeric probe index, then map it back to the opaque ID in Node.
      for (const [index, id] of candidateIds.entries()) {
        for (const input of candidateInputs[index] ?? []) {
          window.api.pty.write(String(id), input)
        }
      }
    },
    { candidateIds, candidateInputs }
  )

  let foundPtyId: string | null = null
  await expect
    .poll(
      async () => {
        const content = await getTerminalContent(page)
        const markerRe = new RegExp(`${marker}_(\\d+)`, 'g')
        const matches = [...content.matchAll(markerRe)]
        if (matches.length > 0) {
          const index = Number(matches.at(-1)?.[1] ?? Number.NaN)
          foundPtyId = Number.isInteger(index) ? (candidateIds[index] ?? null) : null
          return true
        }
        return false
      },
      { timeout: 10_000, message: 'PTY marker did not appear in terminal buffer' }
    )
    .toBe(true)

  if (!foundPtyId) {
    throw new Error('discoverActivePtyId: no marker found in terminal buffer')
  }

  return foundPtyId
}
