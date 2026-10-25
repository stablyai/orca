// Match server session-tab handles to the paired desktop’s bound panes.
import type { RuntimeMobileSessionTabsResult } from '../../../src/shared/runtime-types'
import { toRemoteRuntimePtyId } from '../../../src/shared/remote-runtime-pty-id'
import { toWebTerminalSurfaceTabId } from '../../../src/shared/terminal-surface-id'
import { expect } from './orca-app'
import type { HeadlessPairedRuntimeHost } from './headless-paired-runtime-host'
import type { PairedElectronClient } from './paired-electron-client'

export async function readHostHandles(
  host: HeadlessPairedRuntimeHost,
  worktreeId: string,
  hostTabId: string
): Promise<Record<string, string | null>> {
  const listed = await host.client.call<RuntimeMobileSessionTabsResult>('session.tabs.list', {
    worktree: `id:${worktreeId}`
  })
  return Object.fromEntries(
    listed.result.tabs.flatMap((tab) =>
      tab.type === 'terminal' && tab.parentTabId === hostTabId
        ? [[tab.leafId, tab.status === 'ready' ? tab.terminal : null]]
        : []
    )
  )
}

/** Each pane of the tab binds `remote:` + the handle session.tabs gives its surface now. */
export async function expectPanesBoundToHandles(
  host: HeadlessPairedRuntimeHost,
  client: PairedElectronClient,
  worktreeId: string,
  hostTabId: string,
  leafIds: string[]
): Promise<Record<string, string>> {
  const webTabId = toWebTerminalSurfaceTabId(hostTabId)
  let expected: Record<string, string> = {}
  await expect
    .poll(
      async () => {
        const handles = await readHostHandles(host, worktreeId, hostTabId)
        expected = Object.fromEntries(
          leafIds.map((leafId) => {
            const handle = handles[leafId]
            return [leafId, handle ? toRemoteRuntimePtyId(handle, client.environmentId) : 'none']
          })
        )
        const bound = await client.page.evaluate(
          ({ webTabId, leafIds }) => {
            const state = window.__store!.getState()
            const bindings = state.terminalLayoutsByTabId[webTabId]?.ptyIdsByLeafId ?? {}
            const manager = window.__paneManagers?.get(webTabId)
            const mounted = Object.fromEntries(
              (manager?.getPanes?.() ?? []).map((pane) => [
                pane.container.dataset.leafId ?? '',
                pane.container.dataset.ptyId ?? null
              ])
            )
            return Object.fromEntries(
              leafIds.map((leafId) => [
                leafId,
                { binding: bindings[leafId] ?? null, pane: mounted[leafId] ?? null }
              ])
            )
          },
          { webTabId, leafIds }
        )
        return Object.fromEntries(
          Object.entries(expected).map(([leafId, ptyId]) => [
            leafId,
            bound[leafId]?.binding === ptyId &&
            bound[leafId]?.pane === ptyId &&
            ptyId.startsWith('remote:')
              ? 'bound'
              : { want: ptyId, ...bound[leafId] }
          ])
        )
      },
      { timeout: 90_000, message: 'Desktop panes never bound the session.tabs handles' }
    )
    .toEqual(Object.fromEntries(leafIds.map((leafId) => [leafId, 'bound'])))
  return expected
}

export async function openTab(client: PairedElectronClient, worktreeId: string, webTabId: string) {
  await client.page.evaluate(
    ({ environmentId, worktreeId, webTabId }) => {
      const state = window.__store!.getState()
      state.setActiveView('terminal')
      state.setActiveWorktree(worktreeId, `runtime:${environmentId}`)
      state.setActiveTab(webTabId)
    },
    { environmentId: client.environmentId, worktreeId, webTabId }
  )
  await expect
    .poll(() => client.page.evaluate((id) => window.__paneManagers?.has(id) ?? false, webTabId), {
      timeout: 60_000,
      message: 'The frame-drawn terminal tab never mounted'
    })
    .toBe(true)
}

export async function waitForWorktree(
  host: HeadlessPairedRuntimeHost,
  repoId: string
): Promise<string> {
  let worktreeId = ''
  await expect
    .poll(
      async () => {
        const listed = await host.client.call<{ worktrees: { id: string }[] }>('worktree.list', {
          repo: `id:${repoId}`
        })
        worktreeId = listed.result.worktrees[0]?.id ?? ''
        return worktreeId
      },
      { timeout: 30_000, message: 'Serve host never listed its folder workspace' }
    )
    .not.toBe('')
  return worktreeId
}
