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
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
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
import { mutateStoppedProfileState } from './helpers/persisted-profile-state'
import { quotePosixShell } from '../../src/shared/shell-argument-quoting'
import { makeTerminalScrollbackSnapshotRef } from '../../src/main/terminal-scrollback-snapshots'
import { DEFAULT_LOCAL_ORCA_PROFILE_ID } from '../../src/shared/orca-profiles'
import { ORCAD_MIGRATION_MANIFEST_VERSION } from '../../src/shared/orcad-migration/orcad-migration-manifest-validation'
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
    // Let the host's terminal print before it sleeps; the client never mounts the tab.
    await new Promise((resolve) => setTimeout(resolve, 3_000))
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
    await new Promise((resolve) => setTimeout(resolve, 8_000))
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

const MOVED_TAB = 'moved-tab-0001'
const MOVED_LEAF = 'moved-leaf-0001'
const MOVED_GROUP = 'moved-group-0001'
const MOVED_BROWSER = 'moved-browser-0001'
const MOVED_BROWSER_PAGE = 'moved-browser-page-0001'
const MOVED_BROWSER_URL = 'https://example.invalid/moved-docs'

/**
 * The host's state right after it imported a moved project: a terminal tab whose only history is
 * a stored scrollback snapshot, with no terminal session behind it (the move strips the desktop's).
 */
function seedImportedMovedTab(
  userDataDir: string,
  worktreeId: string,
  history: string,
  importedByWslMove = true
): void {
  const ref = makeTerminalScrollbackSnapshotRef(MOVED_TAB, MOVED_LEAF)
  const roots = [userDataDir, path.join(userDataDir, 'profiles', DEFAULT_LOCAL_ORCA_PROFILE_ID)]
  for (const root of roots) {
    mkdirSync(path.join(root, 'terminal-scrollback'), { recursive: true })
    writeFileSync(path.join(root, 'terminal-scrollback', `${ref}.bin`), history)
  }
  mutateStoppedProfileState(userDataDir, (state) => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this test seeded the profile and reads only these session maps.
    const session = state.workspaceSession as Record<string, Record<string, unknown>>
    // Why: a headless host has no window that would restore the pane itself; keep the fixture's off it.
    Reflect.set(session, 'activeWorktreeId', null)
    if (importedByWslMove) {
      // The receipt a committed WSL move leaves: it is what marks these panes as moved here.
      state.orcadMigrationImportReceipts = [
        {
          version: ORCAD_MIGRATION_MANIFEST_VERSION,
          migrationId: 'moved-history-move',
          manifestSha256: '0'.repeat(64),
          source: {
            kind: 'local-wsl',
            distro: 'Ubuntu',
            scopeRepoIds: [worktreeId.split('::')[0]],
            scopeFolderWorkspaceIds: [],
            generation: 1
          },
          importedAt: '2026-10-23T00:00:00.000Z',
          repositoryIds: [worktreeId.split('::')[0]],
          projectGroupIds: [],
          folderWorkspaceIds: []
        }
      ]
    }
    session.tabsByWorktree = {
      ...session.tabsByWorktree,
      [worktreeId]: [
        {
          id: MOVED_TAB,
          ptyId: null,
          worktreeId,
          title: 'Shell',
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: 0
        }
      ]
    }
    session.unifiedTabs = {
      ...session.unifiedTabs,
      [worktreeId]: [
        {
          id: MOVED_TAB,
          entityId: MOVED_TAB,
          groupId: MOVED_GROUP,
          worktreeId,
          contentType: 'terminal',
          label: 'Shell',
          customLabel: null,
          color: null,
          sortOrder: 0,
          createdAt: 0
        },
        {
          id: MOVED_BROWSER,
          entityId: MOVED_BROWSER,
          groupId: MOVED_GROUP,
          worktreeId,
          contentType: 'browser',
          label: 'Browser 1',
          customLabel: null,
          color: null,
          sortOrder: 1,
          createdAt: 1
        }
      ]
    }
    const page = {
      id: MOVED_BROWSER_PAGE,
      workspaceId: MOVED_BROWSER,
      worktreeId,
      url: MOVED_BROWSER_URL,
      title: 'Moved docs',
      loading: false,
      faviconUrl: null,
      canGoBack: false,
      canGoForward: false,
      loadError: null,
      createdAt: 1
    }
    session.browserTabsByWorktree = {
      ...session.browserTabsByWorktree,
      [worktreeId]: [
        {
          id: MOVED_BROWSER,
          worktreeId,
          label: 'Browser 1',
          activePageId: MOVED_BROWSER_PAGE,
          pageIds: [MOVED_BROWSER_PAGE],
          url: MOVED_BROWSER_URL,
          title: 'Moved docs',
          loading: false,
          faviconUrl: null,
          canGoBack: false,
          canGoForward: false,
          loadError: null,
          createdAt: 1
        }
      ]
    }
    session.browserPagesByWorkspace = {
      ...session.browserPagesByWorkspace,
      [MOVED_BROWSER]: [page]
    }
    session.tabGroups = {
      ...session.tabGroups,
      [worktreeId]: [
        {
          id: MOVED_GROUP,
          worktreeId,
          activeTabId: MOVED_TAB,
          tabOrder: [MOVED_TAB, MOVED_BROWSER]
        }
      ]
    }
    session.activeGroupIdByWorktree = {
      ...session.activeGroupIdByWorktree,
      [worktreeId]: MOVED_GROUP
    }
    session.terminalLayoutsByTabId = {
      ...session.terminalLayoutsByTabId,
      [MOVED_TAB]: {
        root: { type: 'leaf', leafId: MOVED_LEAF },
        activeLeafId: MOVED_LEAF,
        expandedLeafId: null,
        scrollbackRefsByLeafId: { [MOVED_LEAF]: ref }
      }
    }
  })
}

function createRepo(root: string): string {
  const repoPath = path.join(root, 'moved-repo')
  mkdirSync(repoPath)
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repoPath })
  const identity = ['-c', 'user.name=e2e', '-c', 'user.email=e2e@example.invalid']
  execFileSync('git', [...identity, 'commit', '-q', '--allow-empty', '-m', 'init'], {
    cwd: repoPath
  })
  return repoPath
}

type ImportedOutcome = { marker: string; content: string; browserUrls: string[] }

async function openImportedPane(
  testInfo: TestInfo,
  importedByWslMove: boolean
): Promise<ImportedOutcome> {
  const outcome: ImportedOutcome = { marker: '', content: '', browserUrls: [] }
  const root = mkdtempSync(path.join(os.tmpdir(), 'orca-moved-import-'))
  const repoPath = createRepo(root)
  // A windowless host, as the distro's orcad is: nothing there restores a pane or a browser tab itself.
  const host = await launchHeadlessPairedRuntimeHost({ pinnedServePort: true })
  try {
    const added = await host.client.call<{ repo: { id: string } }>('repo.add', {
      path: repoPath,
      kind: 'git'
    })
    const worktreeId = `${added.result.repo.id}::${realpathSync(repoPath)}`
    outcome.marker = `imported-${randomUUID()} before the move`
    await host.restartServeProcess({
      betweenProcesses: () =>
        seedImportedMovedTab(
          host.userDataDir,
          worktreeId,
          `${outcome.marker}\r\n`,
          importedByWslMove
        )
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
      await new Promise((resolve) => setTimeout(resolve, 8_000))
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

test("a moved pane's stored history and browser tab show on the desktop that opens it", async (// oxlint-disable-next-line no-empty-pattern -- Playwright requires destructuring to request no fixtures.
{}, testInfo) => {
  test.skip(process.platform === 'win32', 'POSIX paths')
  test.setTimeout(600_000)
  const outcome = await openImportedPane(testInfo, true)
  // Exactly once: the desktop's own snapshot read must not paint it a second time over the host's.
  expect.soft(outcome.content.split(outcome.marker).length - 1).toBe(1)
  expect.soft(outcome.browserUrls).toContain(MOVED_BROWSER_URL)
})

test("an ordinary pane's saved snapshot is not replayed by a host start", async (// oxlint-disable-next-line no-empty-pattern -- Playwright requires destructuring to request no fixtures.
{}, testInfo) => {
  test.skip(process.platform === 'win32', 'POSIX paths')
  test.setTimeout(600_000)
  // No move receipt: the same saved state on a host that was never a move's destination.
  const outcome = await openImportedPane(testInfo, false)
  expect(outcome.content).not.toContain(outcome.marker)
})
