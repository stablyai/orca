/**
 * `orca terminal switch --environment <server>` run on a desktop's machine must move that desktop
 * to the server's terminal (#24688). The server is a windowless `orca serve`, so before this its
 * answer was `navigated: false` and no window moved.
 *
 * Run:
 *   npx playwright test tests/e2e/paired-terminal-switch-desktop-reveal.spec.ts \
 *     --config tests/playwright.config.ts --project electron-headless --workers=1
 */
import type { Page } from '@stablyai/playwright-test'
import type { RuntimeTerminalFocus } from '../../src/shared/runtime-types'
import { toWebTerminalSurfaceTabId } from '../../src/shared/terminal-surface-id'
import { orcaCliResult } from './helpers/compiled-orca-cli'
import { launchHeadlessPairedRuntimeHost } from './helpers/headless-paired-runtime-host'
import { launchPairedElectronClient } from './helpers/paired-electron-client'
import { expect, test } from './helpers/orca-app'

type HostTerminal = { handle: string; tabId: string; leafId: string }

async function readClientSelection(page: Page, worktreeId: string) {
  return page.evaluate((id) => {
    const state = window.__store?.getState()
    const tabId = state?.activeTabIdByWorktree?.[id] ?? null
    return {
      activeView: state?.activeView ?? null,
      activeWorktreeId: state?.activeWorktreeId ?? null,
      tabId,
      leafId: tabId ? (state?.terminalLayoutsByTabId?.[tabId]?.activeLeafId ?? null) : null
    }
  }, worktreeId)
}

test('terminal switch on a paired server reveals the terminal in the desktop on this machine', async ({
  testRepoPath
}, testInfo) => {
  test.setTimeout(300_000)
  const host = await launchHeadlessPairedRuntimeHost()
  const client = await launchPairedElectronClient(
    host.offer,
    testInfo,
    'terminal-switch-desktop-reveal'
  ).catch(async (error) => {
    await host.dispose()
    throw error
  })
  try {
    const added = await host.client.call<{ repo: { id: string } }>('repo.add', {
      path: testRepoPath,
      kind: 'git'
    })
    let worktreeId = ''
    await expect
      .poll(
        async () => {
          const listed = await host.client.call<{ worktrees: { id: string }[] }>('worktree.list', {
            repo: `id:${added.result.repo.id}`
          })
          worktreeId = listed.result.worktrees[0]?.id ?? ''
          return worktreeId
        },
        { timeout: 30_000, message: 'Serve host never listed a worktree for the seeded repo' }
      )
      .not.toBe('')

    const createHostTerminal = async (title: string): Promise<HostTerminal> => {
      const created = await host.client.call<{ terminal: { handle: string; tabId?: string } }>(
        'terminal.create',
        {
          worktree: `id:${worktreeId}`,
          title,
          focus: false,
          activate: false,
          presentation: 'background'
        }
      )
      const shown = await host.client.call<{ terminal: { leafId: string } }>('terminal.show', {
        terminal: created.result.terminal.handle
      })
      const { handle, tabId } = created.result.terminal
      if (!tabId) {
        throw new Error('Serve host did not report a tab id for the created terminal')
      }
      return { handle, tabId, leafId: shown.result.terminal.leafId }
    }
    const first = await createHostTerminal('build')
    const target = await createHostTerminal('agent waiting')

    // The desktop mirrors a server's tab under a prefixed id; the leaf keeps the server's id.
    const mirroredTargetTabId = toWebTerminalSurfaceTabId(target.tabId)
    await expect
      .poll(
        () =>
          client.page.evaluate(
            ({ id, tabIds }) => {
              const tabs = window.__store?.getState().tabsByWorktree[id] ?? []
              return tabIds.every((tabId) => tabs.some((tab) => tab.id === tabId))
            },
            {
              id: worktreeId,
              tabIds: [toWebTerminalSurfaceTabId(first.tabId), mirroredTargetTabId]
            }
          ),
        { timeout: 60_000, message: 'Paired desktop never mirrored the serve-host terminals' }
      )
      .toBe(true)

    // The user is looking at the other terminal when the switch arrives.
    const firstMirroredTabId = toWebTerminalSurfaceTabId(first.tabId)
    await client.page.evaluate(
      ({ id, tabId }) => {
        const state = window.__store?.getState()
        state?.setActiveWorktree(id)
        state?.setActiveTab(tabId)
      },
      { id: worktreeId, tabId: firstMirroredTabId }
    )
    await expect
      .poll(async () => (await readClientSelection(client.page, worktreeId)).tabId)
      .toBe(firstMirroredTabId)
    await client.page.screenshot({ path: testInfo.outputPath('before-terminal-switch.png') })

    const switched = await orcaCliResult<{ focus: RuntimeTerminalFocus }>(client.userDataDir, [
      'terminal',
      'switch',
      '--environment',
      client.environmentId,
      '--terminal',
      target.handle
    ])

    try {
      expect(switched.focus).toMatchObject({ handle: target.handle, navigated: true })
      await expect
        .poll(() => readClientSelection(client.page, worktreeId), {
          timeout: 30_000,
          message: 'The desktop never moved to the serve-host terminal'
        })
        .toEqual({
          activeView: 'terminal',
          activeWorktreeId: worktreeId,
          tabId: mirroredTargetTabId,
          leafId: target.leafId
        })
      await expect(
        client.page.locator(
          `[data-terminal-tab-id=${JSON.stringify(mirroredTargetTabId)}] .pane[data-leaf-id=${JSON.stringify(target.leafId)}] .xterm`
        )
      ).toBeVisible({ timeout: 30_000 })
      await expect(
        client.page.locator(
          `[data-terminal-tab-id=${JSON.stringify(firstMirroredTabId)}] .xterm:visible`
        )
      ).toHaveCount(0)
    } finally {
      // Why: taken either way, so a run without the fix records the window that did not move.
      await client.page.screenshot({ path: testInfo.outputPath('after-terminal-switch.png') })
    }
  } finally {
    await client.dispose()
    await host.dispose()
  }
})
