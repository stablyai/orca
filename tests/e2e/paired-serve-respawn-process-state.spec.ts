// #35559: a serve host restarted without its daemon restores each pane with a new shell; the dead agent's title, status and input modes must not survive.
import type { Page } from '@stablyai/playwright-test'
import { toWebTerminalSurfaceTabId } from '../../src/shared/terminal-surface-id'
import { expect, test } from './helpers/orca-app'
import { launchHeadlessPairedRuntimeHost } from './helpers/headless-paired-runtime-host'
import {
  launchPairedElectronClient,
  type PairedElectronClient
} from './helpers/paired-electron-client'
import { cleanupE2EDaemons } from './helpers/electron-process-shutdown'

type TerminalListRow = { handle: string; title?: string | null; agentIdentity?: string | null }

async function readPaneState(page: Page, webTabId: string) {
  return page.evaluate((id) => {
    const manager = window.__paneManagers?.get(id)
    const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
    if (!pane) {
      return null
    }
    const state = window.__store?.getState()
    return {
      ptyId: pane.container.dataset.ptyId ?? null,
      mouse: pane.terminal.modes.mouseTrackingMode,
      focus: pane.terminal.modes.sendFocusMode,
      applicationCursor: pane.terminal.modes.applicationCursorKeysMode,
      runtimeTitle: state?.runtimePaneTitlesByTabId?.[id]?.[pane.id] ?? null,
      content: pane.serializeAddon?.serialize?.() ?? ''
    }
  }, webTabId)
}

test('a serve restart that respawns the shell drops the dead agent title, status and modes', async ({
  testRepoPath
}, testInfo) => {
  test.skip(process.platform === 'win32', 'Uses a POSIX printf to arm terminal modes')
  // Two serve relaunches plus a paired client launch outlast the default budget.
  test.setTimeout(420_000)
  const host = await launchHeadlessPairedRuntimeHost({ pinnedServePort: true })
  let client: PairedElectronClient | null = null
  try {
    const added = await host.client.call<{ repo: { id: string } }>('repo.add', {
      path: testRepoPath,
      kind: 'folder'
    })
    let worktreeId = ''
    await expect
      .poll(async () => {
        const listed = await host.client.call<{ worktrees: { id: string }[] }>('worktree.list', {
          repo: `id:${added.result.repo.id}`
        })
        worktreeId = listed.result.worktrees[0]?.id ?? ''
        return worktreeId
      })
      .not.toBe('')
    client = await launchPairedElectronClient(host.offer, testInfo, 'serve-respawn-state')
    const page = client.page
    await expect
      .poll(
        () =>
          page.evaluate(
            (id) =>
              window.__store
                ?.getState()
                .allWorktrees()
                .some((worktree) => worktree.id === id) ?? false,
            worktreeId
          ),
        { timeout: 60_000 }
      )
      .toBe(true)

    const created = await host.client.call<{ terminal: { handle: string; tabId: string } }>(
      'terminal.create',
      { worktree: `id:${worktreeId}`, focus: false, activate: false, presentation: 'background' }
    )
    const webTabId = toWebTerminalSurfaceTabId(created.result.terminal.tabId)
    await page.evaluate(
      ({ environmentId, worktreeId }) => {
        const state = window.__store?.getState()
        state?.setActiveView('terminal')
        state?.setActiveWorktree(worktreeId, `runtime:${environmentId}`)
      },
      { environmentId: client.environmentId, worktreeId }
    )
    const tab = page.locator(`[data-testid="sortable-tab"][data-tab-id="${webTabId}"]`)
    await expect(tab).toBeVisible({ timeout: 60_000 })
    await tab.click()
    await expect
      .poll(() => page.evaluate((id) => window.__paneManagers?.has(id) ?? false, webTabId), {
        timeout: 60_000
      })
      .toBe(true)

    // Stand-in for Claude: a recognised agent title plus mouse, focus, paste and cursor-key modes, kept alive past the restart.
    await host.client.call('terminal.send', {
      terminal: created.result.terminal.handle,
      text: `printf '\\033]0;\\342\\234\\263 Claude Code\\007\\033[?1003h\\033[?1006h\\033[?1004h\\033[?2004h\\033[?1h'; sleep 600`,
      enter: true
    })
    await expect
      .poll(() => readPaneState(page, webTabId), { timeout: 30_000 })
      .toMatchObject({ mouse: 'any', focus: true, applicationCursor: true })
    expect((await readPaneState(page, webTabId))?.runtimeTitle).toContain('Claude Code')

    // A serve restart that keeps the daemon reattaches the same live agent, so its modes must survive.
    await host.restartServeProcess()
    await expect
      .poll(
        async () => {
          const listed = await host.client
            .call<{ terminals: TerminalListRow[] }>('terminal.list', {
              worktree: `id:${worktreeId}`
            })
            .catch(() => null)
          const handle = listed?.result.terminals[0]?.handle
          if (!handle) {
            return false
          }
          await host.client.call('terminal.send', { terminal: handle, text: 'LIVE_PROBE' })
          return (await readPaneState(page, webTabId))?.content.includes('LIVE_PROBE') ?? false
        },
        { timeout: 120_000, message: 'The paired pane never reattached after the serve restart' }
      )
      .toBe(true)
    expect(await readPaneState(page, webTabId)).toMatchObject({
      mouse: 'any',
      focus: true,
      applicationCursor: true
    })
    const before = await readPaneState(page, webTabId)

    // The host machine restarted: serve and its daemon both lose every process.
    await host.restartServeProcess({ betweenProcesses: () => cleanupE2EDaemons(host.userDataDir) })

    await expect
      .poll(async () => (await readPaneState(page, webTabId))?.ptyId !== before?.ptyId, {
        timeout: 120_000
      })
      .toBe(true)
    // Bracketed paste is left out: a modern shell re-arms it at its first prompt.
    await expect
      .poll(() => readPaneState(page, webTabId), { timeout: 30_000 })
      .toMatchObject({ mouse: 'none', focus: false, applicationCursor: false })
    expect((await readPaneState(page, webTabId))?.runtimeTitle ?? '').not.toContain('Claude Code')
    const listedAfter = await host.client.call<{ terminals: TerminalListRow[] }>('terminal.list', {
      worktree: `id:${worktreeId}`
    })
    expect(listedAfter.result.terminals.map((row) => row.agentIdentity ?? null)).toEqual([null])
    expect(listedAfter.result.terminals.map((row) => row.title ?? '')).not.toContainEqual(
      expect.stringContaining('Claude Code')
    )
  } finally {
    await client?.dispose()
    await host.dispose()
  }
})
