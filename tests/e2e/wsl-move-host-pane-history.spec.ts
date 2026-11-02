/**
 * A moved project's terminals, as the desktop sees them once the WSL host owns them: the host
 * serves the workspace, its panes were put to sleep (so the host holds only a stored scrollback
 * snapshot and no live terminal), and this desktop has never painted them. Opening the tab must
 * show the history the pane had before it slept.
 *
 * Topology: the headed fixture app stands in for the distro's orcad; a paired desktop client
 * stands in for the moving desktop. The host's own sleep writes the snapshot the move would.
 *
 * Run:
 *   pnpm exec playwright test tests/e2e/wsl-move-host-pane-history.spec.ts \
 *     --config tests/playwright.config.ts --project electron-headless --workers=1
 */
import { randomUUID } from 'node:crypto'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Page, TestInfo } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import {
  createRuntimeDesktopPairingOffer,
  launchPairedElectronClient
} from './helpers/paired-electron-client'
import {
  callEnvironment,
  createPairedHostTerminal,
  openPairedClientTab,
  readPairedPaneContent
} from './helpers/paired-host-terminal'
import { launchHeadlessPairedRuntimeHost } from './helpers/headless-paired-runtime-host'
import { createMovedRepo, MOVED_TAB, seedImportedMovedTab } from './helpers/wsl-moved-host-profile'
import { quotePosixShell } from '../../src/shared/shell-argument-quoting'
import { toWebTerminalSurfaceTabId } from '../../src/shared/terminal-surface-id'

const scratch = mkdtempSync(path.join(os.tmpdir(), 'orca-moved-history-'))
const fixturePath = path.join(scratch, 'history-terminal.mjs')
writeFileSync(
  fixturePath,
  [
    'const marker = process.argv[2]',
    'for (let i = 0; i < 40; i += 1) process.stdout.write(`${marker} line ${i}\\r\\n`)',
    'process.stdin.resume()'
  ].join('\n')
)

test.afterAll(() => {
  rmSync(scratch, { recursive: true, force: true })
})

function fixtureCommand(marker: string): string {
  return [process.execPath, fixturePath, marker].map(quotePosixShell).join(' ')
}

type ClientTabState = {
  refs: Record<string, string>
  ptyIds: Record<string, string>
  buffers: number
  localOnly: number
}

async function readClientTabState(page: Page, tabId: string): Promise<ClientTabState> {
  return page.evaluate((id) => {
    const state = window.__store?.getState()
    const layout = state?.terminalLayoutsByTabId?.[id]
    return {
      refs: { ...layout?.scrollbackRefsByLeafId },
      ptyIds: { ...layout?.ptyIdsByLeafId },
      buffers: Object.values(layout?.buffersByLeafId ?? {}).join('').length,
      localOnly: Object.values(state?.localOnlyScrollbackByTabId?.[id] ?? {}).join('').length
    }
  }, tabId)
}

test('a slept host pane this desktop never painted shows its history when opened', async ({
  orcaPage
}, testInfo) => {
  test.skip(process.platform === 'win32', 'POSIX fixture command')
  // A paired host and client each boot a full app, and the host terminal runs before the check.
  test.setTimeout(600_000)
  const worktreeId = await orcaPage.evaluate(() => {
    const id = window.__store?.getState().activeWorktreeId
    if (!id) {
      throw new Error('host has no active worktree')
    }
    return id
  })
  const offer = await createRuntimeDesktopPairingOffer(orcaPage)
  const client = await launchPairedElectronClient(offer, testInfo, 'moved-history')
  try {
    await expect
      .poll(
        () =>
          client.page.evaluate(
            (id) =>
              Boolean(
                window.__store
                  ?.getState()
                  .allWorktrees()
                  .some((worktree) => worktree.id === id)
              ),
            worktreeId
          ),
        { timeout: 60_000 }
      )
      .toBe(true)
    const marker = `moved-${randomUUID()}`
    const terminal = await createPairedHostTerminal(
      client.page,
      client.environmentId,
      worktreeId,
      fixtureCommand(marker)
    )
    // The host's terminal prints before it sleeps; the client never mounts the tab.
    await expect
      .poll(
        async () => {
          const read = await callEnvironment(client.page, client.environmentId, 'terminal.read', {
            terminal: terminal.terminal,
            screen: true
          })
          return JSON.stringify(read).includes(`${marker} line 39`)
        },
        { timeout: 30_000, message: 'the host terminal never printed its last line' }
      )
      .toBe(true)
    await callEnvironment(client.page, client.environmentId, 'worktree.sleep', {
      worktree: `id:${worktreeId}`
    })
    await client.page.evaluate((id) => {
      const state = window.__store?.getState()
      state?.setActiveView('terminal')
      state?.setActiveWorktree(id)
    }, worktreeId)
    console.log(
      `[moved-history] before-open ${JSON.stringify(await readClientTabState(client.page, terminal.webTabId))}`
    )
    await openPairedClientTab(client.page, worktreeId, terminal.webTabId)
    await expect
      .poll(() => readPairedPaneContent(client.page, terminal.webTabId), { timeout: 30_000 })
      .toContain(`${marker} line 39`)
    console.log(
      `[moved-history] after-open ${JSON.stringify(await readClientTabState(client.page, terminal.webTabId))}`
    )
    const content = await readPairedPaneContent(client.page, terminal.webTabId)
    console.log(`[moved-history] content-tail ${JSON.stringify(content.slice(-400))}`)
    expect(content).toContain(`${marker} line 39`)
  } finally {
    await client.dispose()
  }
})

type ImportedOutcome = { marker: string; content: string; browserUrls: string[] }

async function openImportedPane(
  testInfo: TestInfo,
  importedByWslMove: boolean
): Promise<ImportedOutcome> {
  const outcome: ImportedOutcome = { marker: '', content: '', browserUrls: [] }
  const root = mkdtempSync(path.join(os.tmpdir(), 'orca-moved-import-'))
  const repoPath = createMovedRepo(root)
  // A windowless host, as the distro's orcad is: nothing there restores a pane or a browser tab itself.
  const host = await launchHeadlessPairedRuntimeHost({
    pinnedServePort: true,
    // Stands in for the distro's orcad, the only host that serves moved panes' history.
    extraEnv: { ORCA_E2E_WSL_MOVE_DESTINATION: '1' }
  })
  try {
    const added = await host.client.call<{ repo: { id: string } }>('repo.add', {
      path: repoPath,
      kind: 'git'
    })
    const worktreeId = `${added.result.repo.id}::${realpathSync(repoPath)}`
    outcome.marker = `imported-${randomUUID()} before the move`
    await host.restartServeProcess({
      betweenProcesses: () =>
        seedImportedMovedTab(host.userDataDir, worktreeId, `${outcome.marker}\r\n`, {
          importedByWslMove
        })
    })
    const client = await launchPairedElectronClient(host.offer, testInfo, 'moved-import')
    try {
      const webTabId = toWebTerminalSurfaceTabId(MOVED_TAB)
      await expect
        .poll(
          () =>
            client.page.evaluate(
              (id) =>
                Boolean(
                  window.__store
                    ?.getState()
                    .allWorktrees()
                    .some((worktree) => worktree.id === id)
                ),
              worktreeId
            ),
          { timeout: 60_000 }
        )
        .toBe(true)
      await client.page.evaluate((id) => {
        const state = window.__store?.getState()
        state?.setActiveView('terminal')
        state?.setActiveWorktree(id)
      }, worktreeId)
      await openPairedClientTab(client.page, worktreeId, webTabId)
      // The pane has started once it shows anything: its replayed history or a fresh prompt.
      await expect
        .poll(async () => (await readPairedPaneContent(client.page, webTabId)).trim().length, {
          timeout: 30_000
        })
        .toBeGreaterThan(0)
      const state = await readClientTabState(client.page, webTabId)
      console.log(`[moved-history] import after-open ${JSON.stringify(state)}`)
      outcome.content = await readPairedPaneContent(client.page, webTabId)
      console.log(
        `[moved-history] import content-tail ${JSON.stringify(outcome.content.slice(-300))}`
      )
      outcome.browserUrls = await client.page.evaluate((id) => {
        const store = window.__store?.getState()
        return (store?.browserTabsByWorktree[id] ?? []).flatMap((workspace) =>
          (store?.browserPagesByWorkspace[workspace.id] ?? []).map((page) => page.url)
        )
      }, worktreeId)
      console.log(`[moved-history] import browser-urls ${JSON.stringify(outcome.browserUrls)}`)
      return outcome
    } finally {
      await client.dispose()
    }
  } finally {
    await host.dispose()
    rmSync(root, { recursive: true, force: true })
  }
}

test("an ordinary pane's saved snapshot is not replayed by a host start", async (// oxlint-disable-next-line no-empty-pattern -- Playwright requires destructuring to request no fixtures.
{}, testInfo) => {
  test.skip(process.platform === 'win32', 'POSIX paths')
  // A paired host and client each boot a full app, and the host terminal runs before the check.
  test.setTimeout(600_000)
  // No move receipt: the same saved state on a host that was never a move's destination.
  const outcome = await openImportedPane(testInfo, false)
  expect(outcome.content).not.toContain(outcome.marker)
})
