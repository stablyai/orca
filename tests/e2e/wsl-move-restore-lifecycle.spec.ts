/**
 * The restart-style restore a WSL move ends in, from the pane's own daemon checkpoint to what the
 * desktop shows across reloads. The distro's orcad is a windowless paired host; the desktop is a
 * paired client. The move's export reads the host pane's real checkpoint, the host's installer
 * lays it into its daemon's history, and the host's first start of that pane replays it once.
 *
 * Run:
 *   pnpm exec playwright test tests/e2e/wsl-move-restore-lifecycle.spec.ts \
 *     --config tests/playwright.config.ts --project electron-headless --workers=1
 */
import { randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { launchPairedElectronClient } from './helpers/paired-electron-client'
import { launchHeadlessPairedRuntimeHost } from './helpers/headless-paired-runtime-host'
import { openPairedClientTab, readPairedPaneContent } from './helpers/paired-host-terminal'
import { mutateStoppedProfileState } from './helpers/persisted-profile-state'
import { attachRepoAndOpenTerminal, createRestartSession } from './helpers/orca-restart'
import { ensureTerminalVisible, waitForSessionReady } from './helpers/store'
import {
  execInTerminal,
  getTerminalContent,
  waitForActivePanePtyId,
  waitForTerminalOutput
} from './helpers/terminal'
import {
  createMovedRepo,
  MOVED_BROWSER_URL,
  MOVED_TAB,
  movedWorkspaceRows,
  withMovedRows
} from './helpers/wsl-moved-host-profile'
import { HistoryReader } from '../../src/main/daemon/history-reader'
import { getOrcadMigrationReceivedBlobPath } from '../../src/main/persistence/migrating-orcad-catalog/orcad-migration-blob-staging'
import {
  installOrcadMigrationTerminalHistory,
  orcadMigrationTerminalHistoryKey
} from '../../src/main/persistence/migrating-orcad-catalog/orcad-terminal-history-installer'
import { readWslMoveSleptScrollbackFromHistory } from '../../src/main/persistence/moving-wsl-projects/wsl-move-slept-scrollback'
import { wslMoveCutoverFixture } from '../../src/main/persistence/__fixtures__/wsl-mover/wsl-move-cutover-fixture'
import { seedWslMoveCutover } from '../../src/main/persistence/__fixtures__/wsl-mover/wsl-move-journal-seeding'
import { toRuntimeExecutionHostId } from '../../src/shared/execution-host'
import { WSL_HOSTS_INTERNAL_GATE_ENV } from '../../src/shared/wsl-host-internal-gate'
import type { RuntimeTerminalListResult } from '../../src/shared/runtime-terminal-contracts'
import { quotePosixShell } from '../../src/shared/shell-argument-quoting'
import { toWebTerminalSurfaceTabId } from '../../src/shared/terminal-surface-id'

const LINES = 2_000
const LEAF = '6f1b0c3e-8d2a-4c5b-9e7f-1a2b3c4d5e6f'
const DRAFT = 'unsaved words typed before the move'
const MIGRATION = { migrationId: 'restore-lifecycle-move', manifestSha256: 'a'.repeat(64) }

const scratch = mkdtempSync(path.join(os.tmpdir(), 'orca-restore-lifecycle-'))
const printerPath = path.join(scratch, 'print-history.mjs')
writeFileSync(
  printerPath,
  [
    'const marker = process.argv[2]',
    `for (let i = 1; i <= ${LINES}; i += 1) process.stdout.write(\`\${marker} \${String(i).padStart(4, '0')}\\r\\n\`)`,
    'process.stdin.resume()'
  ].join('\n')
)

test.afterAll(() => {
  rmSync(scratch, { recursive: true, force: true })
})

/** The daemon history folders under a profile, whichever profile root the host wrote them in. */
function historyRoots(userDataDir: string): string[] {
  const found: string[] = []
  const walk = (dir: string, depth: number): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue
      }
      const full = path.join(dir, entry.name)
      if (entry.name === 'terminal-history') {
        found.push(full)
      } else if (depth < 3) {
        walk(full, depth + 1)
      }
    }
  }
  walk(userDataDir, 0)
  return found
}

function sessionFolders(root: string): string[] {
  return readdirSync(root).filter((name) => existsSync(path.join(root, name, 'checkpoint.json')))
}

function count(text: string, needle: string): number {
  return text.split(needle).length - 1
}

type ShownPane = { first: number; last: number; content: string }

async function readShownPane(page: Page, webTabId: string, marker: string): Promise<ShownPane> {
  let content = ''
  await expect
    .poll(
      async () => {
        content = await readPairedPaneContent(page, webTabId)
        return content.includes(`${marker} ${String(LINES).padStart(4, '0')}`)
      },
      { timeout: 60_000, message: 'the moved pane never showed its history' }
    )
    .toBe(true)
  return {
    first: count(content, `${marker} 0001`),
    last: count(content, `${marker} ${String(LINES).padStart(4, '0')}`),
    content
  }
}

test('a moved pane shows its own history once, in its folder, across three reloads, with its browser tab and draft', async (// oxlint-disable-next-line no-empty-pattern -- Playwright requires destructuring to request no fixtures.
{}, testInfo) => {
  test.skip(process.platform === 'win32', 'POSIX fixture command')
  test.setTimeout(900_000)
  const root = mkdtempSync(path.join(os.tmpdir(), 'orca-restore-lifecycle-repo-'))
  const repoPath = realpathSync(createMovedRepo(root))
  const deep = path.join(repoPath, 'deep')
  mkdirSync(deep)
  const notesPath = path.join(repoPath, 'notes.md')
  writeFileSync(notesPath, 'saved words\n')
  const openFile = { filePath: notesPath, relativePath: 'notes.md' }
  const marker = `MOVED-${randomUUID().slice(0, 8)}`
  const host = await launchHeadlessPairedRuntimeHost({
    pinnedServePort: true,
    withoutBrowser: true
  })
  try {
    const added = await host.client.call<{ repo: { id: string } }>('repo.add', {
      path: repoPath,
      kind: 'git'
    })
    const worktreeId = `${added.result.repo.id}::${repoPath}`

    // The pane before the move: a real daemon session that printed its history, then slept, so
    // its final checkpoint is on disk as the move's export reads it.
    const before = new Set(historyRoots(host.userDataDir).flatMap(sessionFolders))
    await host.client.call('session.tabs.createTerminal', {
      worktree: `id:${worktreeId}`,
      command: [process.execPath, printerPath, marker].map(quotePosixShell).join(' '),
      activate: false,
      select: false,
      navigation: 'caller'
    })
    await new Promise((resolve) => setTimeout(resolve, 5_000))
    await host.client.call('worktree.sleep', { worktree: `id:${worktreeId}` })
    let historyRoot = ''
    let sessionFolder = ''
    await expect
      .poll(
        () => {
          for (const candidate of historyRoots(host.userDataDir)) {
            const fresh = sessionFolders(candidate).find((name) => !before.has(name))
            if (fresh) {
              historyRoot = candidate
              sessionFolder = fresh
              return true
            }
          }
          return false
        },
        { timeout: 60_000, message: 'the slept pane left no checkpoint' }
      )
      .toBe(true)

    // The move's export: the desktop reads that checkpoint as its terminal-history blob, with the
    // folder the shell was in (the distro's /proc read stands in as `shellCwd`).
    const paneKey = `${MOVED_TAB}:${LEAF}`
    const spool = path.join(scratch, 'spool')
    const exported = await readWslMoveSleptScrollbackFromHistory(
      new HistoryReader(historyRoot),
      [{ paneKey, sessionId: decodeURIComponent(sessionFolder), shellCwd: deep }],
      'Ubuntu',
      spool
    )
    expect(exported.problems).toEqual([])
    const blob = exported.buffers.get(paneKey)
    if (!blob) {
      throw new Error('the export carried no history for the moved pane')
    }

    // The host's import: the moved tab in its session (no binding, no snapshot), and its history
    // laid into the daemon's folder by the real installer.
    await host.restartServeProcess({
      betweenProcesses: () => {
        mutateStoppedProfileState(host.userDataDir, (state) => {
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this test seeded the profile and writes only these session maps.
          const session = state.workspaceSession as Record<string, unknown>
          Reflect.set(session, 'activeWorktreeId', null)
          withMovedRows(
            session,
            movedWorkspaceRows(worktreeId, {
              openFiles: [openFile],
              browserTab: false,
              daemonHistoryLeafId: LEAF
            })
          )
        })
        const received = getOrcadMigrationReceivedBlobPath(scratch, MIGRATION, {
          blobKind: 'terminal-history',
          key: orcadMigrationTerminalHistoryKey(paneKey)
        })
        mkdirSync(path.dirname(received), { recursive: true })
        writeFileSync(received, readFileSync(blob.path))
        installOrcadMigrationTerminalHistory({
          migration: MIGRATION,
          root: scratch,
          historyRoot,
          paneWorktreeId: () => worktreeId,
          workspacePath: () => repoPath,
          now: Date.now()
        })
      }
    })

    const first = await launchPairedElectronClient(host.offer, testInfo, 'restore-lifecycle')
    const { environmentId, userDataDir } = first
    let client = first
    const webTabId = toWebTerminalSurfaceTabId(MOVED_TAB)
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
      await client.quitPreservingProfile()
      // What the move's seed leaves in this desktop's copy of the host's session.
      mutateStoppedProfileState(userDataDir, (state) => {
        const held = state.workspaceSessionsByHostId
        const partitions: Record<string, unknown> =
          held && typeof held === 'object' ? { ...held } : {}
        const hostId = toRuntimeExecutionHostId(environmentId)
        const current = partitions[hostId]
        const partition: Record<string, unknown> =
          current && typeof current === 'object' ? { ...current } : {}
        withMovedRows(
          partition,
          movedWorkspaceRows(worktreeId, {
            openFiles: [{ ...openFile, dirtyDraftContent: DRAFT }],
            runtimeEnvironmentId: environmentId,
            daemonHistoryLeafId: LEAF
          })
        )
        state.workspaceSessionsByHostId = { ...partitions, [hostId]: partition }
      })

      const shown: ShownPane[] = []
      for (let launch = 0; launch < 4; launch += 1) {
        client = await launchPairedElectronClient(host.offer, testInfo, 'restore-lifecycle', {
          reuseUserDataDir: userDataDir
        })
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
        await openPairedClientTab(client.page, worktreeId, webTabId)
        const pane = await readShownPane(client.page, webTabId, marker)
        console.log(
          `[restore-lifecycle] launch ${launch}: first=${pane.first} last=${pane.last} chars=${pane.content.length}`
        )
        shown.push(pane)
        if (launch === 0) {
          // The shell the host started for the pane sits in the folder the pane was in.
          await expect
            .poll(
              async () => {
                const listed = await host.client.call<RuntimeTerminalListResult>('terminal.list', {
                  worktree: `id:${worktreeId}`
                })
                const moved = listed.result.terminals.find((entry) => entry.tabId === MOVED_TAB)
                if (moved) {
                  await host.client.call('terminal.send', {
                    terminal: moved.handle,
                    text: 'pwd',
                    enter: true
                  })
                }
                return (await readPairedPaneContent(client.page, webTabId)).includes(deep)
              },
              { timeout: 30_000, message: 'the restored shell is not in the moved folder' }
            )
            .toBe(true)
          const moved = await client.page.evaluate(
            ({ id, path: filePath }) => {
              const store = window.__store?.getState()
              const browserUrls = (store?.browserTabsByWorktree[id] ?? []).flatMap((workspace) =>
                (store?.browserPagesByWorkspace[workspace.id] ?? []).map((page) => page.url)
              )
              const file = store?.openFiles.find(
                (entry) => entry.worktreeId === id && entry.filePath === filePath
              )
              return { browserUrls, draft: file ? (store?.editorDrafts[file.id] ?? null) : null }
            },
            { id: worktreeId, path: notesPath }
          )
          expect.soft(moved.browserUrls).toContain(MOVED_BROWSER_URL)
          expect.soft(moved.draft).toBe(DRAFT)
        }
        if (launch < 3) {
          await client.quitPreservingProfile()
        }
      }
      for (const pane of shown) {
        // Every line of the pane's history, exactly once: no second replay after any reload.
        expect.soft(pane.last).toBe(1)
        expect.soft(pane.first).toBe(1)
      }
    } finally {
      await client.dispose()
    }
  } finally {
    await host.dispose()
    rmSync(root, { recursive: true, force: true })
  }
})

test('"Use on this computer again" brings back a slept pane live, with its history once', async (// oxlint-disable-next-line no-empty-pattern -- Playwright requires destructuring to request no fixtures.
{}, testInfo) => {
  test.skip(process.platform === 'win32', 'POSIX shell commands')
  test.setTimeout(600_000)
  const root = mkdtempSync(path.join(os.tmpdir(), 'orca-restore-lifecycle-undo-'))
  const repoPath = realpathSync(createMovedRepo(root))
  const session = createRestartSession(testInfo, { [WSL_HOSTS_INTERNAL_GATE_ENV]: '1' })
  let launched: Awaited<ReturnType<typeof session.launch>> | undefined
  try {
    launched = await session.launch()
    await waitForSessionReady(launched.page)
    const worktreeId = await attachRepoAndOpenTerminal(launched.page, repoPath)
    await ensureTerminalVisible(launched.page)
    const ptyId = await waitForActivePanePtyId(launched.page)
    // The variable keeps the printed lines out of the echoed command.
    await execInTerminal(launched.page, ptyId, `M=UNDO; seq -f "\${M}X-%04g" 1 ${LINES}`)
    await waitForTerminalOutput(launched.page, `UNDOX-${LINES}`, 30_000)
    // The move's pause: Sleep, which keeps the pane's identity and its final checkpoint.
    await launched.page.evaluate(async (id) => {
      const state = window.__store!.getState()
      await state.shutdownWorktreeBrowsers(id)
      await state.shutdownWorktreeTerminals(id, { keepIdentifiers: true })
    }, worktreeId)
    const repoId = worktreeId.split('::')[0]
    await session.close(launched.app)
    launched = undefined

    // The move committed and its source is retained here, frozen as the pause left it.
    seedWslMoveCutover(
      session.userDataDir,
      wslMoveCutoverFixture('move-1', 'retained', {}, { repoIds: [repoId] })
    )
    launched = await session.launch()
    const { page } = launched
    await waitForSessionReady(page)
    const entry = page.getByTestId('wsl-moved-project')
    await expect(entry).toBeVisible({ timeout: 30_000 })
    const reloaded = page.waitForEvent('load')
    await entry.getByTestId('wsl-moved-use-here').click()
    await page.getByRole('dialog').getByRole('button', { name: 'Use on this computer' }).click()
    await reloaded
    await waitForSessionReady(page)

    await page.evaluate((id) => window.__store!.getState().setActiveWorktree(id), worktreeId)
    await ensureTerminalVisible(page)
    await waitForTerminalOutput(page, `UNDOX-${LINES}`, 60_000)
    const restored = await getTerminalContent(page, 1_000_000)
    console.log(
      `[restore-lifecycle] undo: first=${count(restored, 'UNDOX-0001')} last=${count(restored, `UNDOX-${LINES}`)}`
    )
    expect.soft(count(restored, `UNDOX-${LINES}`)).toBe(1)
    // A live pane: what is typed now runs.
    const live = await waitForActivePanePtyId(page)
    await execInTerminal(page, live, 'echo "ALIVE-$((40 + 2))"')
    await waitForTerminalOutput(page, 'ALIVE-42', 30_000)
  } finally {
    if (launched) {
      await session.close(launched.app)
    }
    await session.dispose()
    rmSync(root, { recursive: true, force: true })
  }
})
