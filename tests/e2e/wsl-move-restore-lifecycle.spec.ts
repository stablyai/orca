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
import { z } from 'zod'
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
  splitActiveTerminalPane,
  waitForActivePaneHookDescriptor,
  waitForActivePanePtyId,
  waitForPaneCount,
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
  movedPaneHistorySessionId,
  orcadMigrationTerminalHistoryKey
} from '../../src/main/persistence/migrating-orcad-catalog/orcad-terminal-history-installer'
import { getHistorySessionDirName } from '../../src/main/daemon/history-paths'
import { readWslMoveSleptScrollbackFromHistory } from '../../src/main/persistence/moving-wsl-projects/wsl-move-slept-scrollback'
import { wslMoveCutoverFixture } from '../../src/main/persistence/__fixtures__/wsl-mover/wsl-move-cutover-fixture'
import { seedWslMoveCutover } from '../../src/main/persistence/__fixtures__/wsl-mover/wsl-move-journal-seeding'
import { toRuntimeExecutionHostId } from '../../src/shared/execution-host'
import { WSL_HOSTS_INTERNAL_GATE_ENV } from '../../src/shared/wsl-host-internal-gate'
import { quotePosixShell } from '../../src/shared/shell-argument-quoting'
import { toWebTerminalSurfaceTabId } from '../../src/shared/terminal-surface-id'

const LINES = 2_000
const LEAF = '6f1b0c3e-8d2a-4c5b-9e7f-1a2b3c4d5e6f'
const DRAFT = 'unsaved words typed before the move'
// What the undo e2e reads of a saved session: its agent records, everything else kept as is.
const SessionWithAgentRecords = z
  .object({
    sleepingAgentSessionsByPaneKey: z
      .record(
        z.string(),
        z
          .object({ providerSession: z.object({ id: z.unknown() }).passthrough().optional() })
          .passthrough()
      )
      .optional()
  })
  .passthrough()
const MOVED_AGENT_SESSION = 'e2e-wsl-moved-resume-session'
const UNDO_AGENT_SESSION = 'e2e-wsl-undo-resume-session'
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

const stubAgentDir = path.join(scratch, 'agents')
mkdirSync(stubAgentDir)
writeFileSync(
  path.join(stubAgentDir, 'codex'),
  '#!/bin/sh\necho "STUB_CODEX_ARGV $*"\necho "STUB_CODEX_CWD $PWD"\necho "STUB_CODEX_OLDPWD $OLDPWD"\nexec cat\n',
  {
    mode: 0o755
  }
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
  // A move, three reloads and a restart, each booting a full app against a real daemon.
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
    withoutBrowser: true,
    // Stands in for the distro's orcad, the only host that serves moved panes' history.
    extraEnv: { ORCA_E2E_WSL_MOVE_DESTINATION: '1' }
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
    const created = await host.client.call<{ tab: { terminal: string } }>(
      'session.tabs.createTerminal',
      {
        worktree: `id:${worktreeId}`,
        command: [process.execPath, printerPath, marker].map(quotePosixShell).join(' '),
        activate: false,
        select: false,
        navigation: 'caller'
      }
    )
    const lastLine = `${marker} ${String(LINES).padStart(4, '0')}`
    // The printer finishes its history before the pane sleeps.
    await expect
      .poll(
        async () => {
          const read = await host.client.call('terminal.read', {
            terminal: created.result.tab.terminal,
            screen: true
          })
          return JSON.stringify(read.result).includes(lastLine)
        },
        { timeout: 30_000, message: 'the printer never printed its last line' }
      )
      .toBe(true)
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
          // The agent's own session file on the host, as the distro keeps it: a resume whose owning
          // account cannot be verified starts the agent fresh instead.
          const codexHome = host.env.CODEX_HOME ?? path.join(host.env.HOME ?? '', '.codex')
          const sessionsDir = path.join(codexHome, 'sessions', '2026', '07', '28')
          mkdirSync(sessionsDir, { recursive: true })
          const transcriptPath = path.join(
            sessionsDir,
            `rollout-2026-07-28T00-00-00-${MOVED_AGENT_SESSION}.jsonl`
          )
          writeFileSync(
            transcriptPath,
            `${JSON.stringify({
              timestamp: '2026-07-28T00:00:00.000Z',
              type: 'session_meta',
              payload: { id: MOVED_AGENT_SESSION, cwd: deep }
            })}\n`
          )
          // The pane's idle agent, as the move carries it: resumed in the pane when it opens.
          Reflect.set(session, 'sleepingAgentSessionsByPaneKey', {
            [paneKey]: {
              paneKey,
              tabId: MOVED_TAB,
              worktreeId,
              agent: 'codex',
              providerSession: { key: 'session_id', id: MOVED_AGENT_SESSION, transcriptPath },
              prompt: 'finish the task',
              state: 'done',
              capturedAt: 1,
              updatedAt: 1,
              origin: 'worktree-sleep',
              restoreOnTabOpenOnly: true,
              // The command a launch recorded; absolute, since a login shell may reset PATH.
              launchConfig: {
                agentCommand: path.join(stubAgentDir, 'codex'),
                agentArgs: '',
                agentEnv: {}
              }
            }
          })
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
        try {
          await expect
            .poll(
              async () =>
                (await readPairedPaneContent(client.page, webTabId)).includes('STUB_CODEX_CWD'),
              {
                timeout: 60_000,
                message: 'the carried agent never started in the moved pane'
              }
            )
            .toBe(true)
        } catch (error) {
          // What the pane shows instead: a refused resume names itself, a plain shell shows its prompt.
          const tail = (await readPairedPaneContent(client.page, webTabId)).slice(-800)
          console.log(`[restore-lifecycle] launch ${launch} pane tail: ${JSON.stringify(tail)}`)
          throw error
        }
        const pane = await readShownPane(client.page, webTabId, marker)
        const resumes = count(pane.content, 'STUB_CODEX_CWD')
        console.log(
          `[restore-lifecycle] launch ${launch}: first=${pane.first} last=${pane.last} agent=${resumes} chars=${pane.content.length}`
        )
        shown.push(pane)
        if (launch === 0) {
          // The agent resumed in the folder the pane was in (the stub prints where it started).
          if (
            ![`STUB_CODEX_CWD ${deep}\r`, `STUB_CODEX_OLDPWD ${deep}\r`].some((line) =>
              pane.content.includes(line)
            )
          ) {
            // Diagnostics for a pane that resumed outside its folder: which terminal, from which history.
            const listed = await host.client.call('terminal.list', { worktree: `id:${worktreeId}` })
            const movedSession = movedPaneHistorySessionId(worktreeId, paneKey)
            const folder = path.join(historyRoot, getHistorySessionDirName(movedSession))
            const read = (name: string): string =>
              existsSync(path.join(folder, name))
                ? readFileSync(path.join(folder, name), 'utf8').slice(0, 300)
                : 'missing'
            // A login profile that changes folder or HOME moves every login shell (Blacksmith's does).
            const profileDir = '/etc/profile.d'
            const profiles = existsSync(profileDir)
              ? readdirSync(profileDir)
                  .filter((name) => name.endsWith('.sh'))
                  .map((name) => {
                    const text = readFileSync(path.join(profileDir, name), 'utf8')
                    return `${name}: ${text
                      .split('\n')
                      .filter((line) => /\bcd\b|HOME|PWD/.test(line))
                      .join(' | ')}`
                  })
              : []
            console.log(`[restore-lifecycle] login profiles: ${JSON.stringify(profiles)}`)
            console.log(
              `[restore-lifecycle] wrong folder: terminals=${JSON.stringify(listed.result)} meta=${read('meta.json')} checkpointCwd=${JSON.stringify(/"cwd":"[^"]*"/.exec(read('checkpoint.json'))?.[0] ?? null)} tail=${JSON.stringify(pane.content.slice(-900))}`
            )
          }
          // Where Orca started the pane's shell. A login profile that cds (CI runners' does, into
          // GITHUB_WORKSPACE) moves every login shell after it starts; the folder it left is OLDPWD.
          expect
            .soft(
              [`STUB_CODEX_CWD ${deep}\r`, `STUB_CODEX_OLDPWD ${deep}\r`].some((line) =>
                pane.content.includes(line)
              )
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
      // The carried agent resumed on the first open only: a reload never resumes it again.
      expect.soft(shown[0]?.content).toContain(`resume ${MOVED_AGENT_SESSION}`)
      expect.soft(shown.map((pane) => count(pane.content, 'STUB_CODEX_CWD'))).toEqual([1, 1, 1, 1])
    } finally {
      await client.dispose()
    }
  } finally {
    await host.dispose()
    rmSync(root, { recursive: true, force: true })
  }
})

test('"Use on this computer again" after reloads and a restart brings back slept panes live, each with its history once', async (// oxlint-disable-next-line no-empty-pattern -- Playwright requires destructuring to request no fixtures.
{}, testInfo) => {
  test.skip(process.platform === 'win32', 'POSIX shell commands')
  // A move, reloads, a restart and the undo's reload, each booting a full app.
  test.setTimeout(900_000)
  const root = mkdtempSync(path.join(os.tmpdir(), 'orca-restore-lifecycle-undo-'))
  const repoPath = realpathSync(createMovedRepo(root))
  const session = createRestartSession(testInfo, { [WSL_HOSTS_INTERNAL_GATE_ENV]: '1' })
  let launched: Awaited<ReturnType<typeof session.launch>> | undefined
  try {
    launched = await session.launch()
    await waitForSessionReady(launched.page)
    const worktreeId = await attachRepoAndOpenTerminal(launched.page, repoPath)
    await ensureTerminalVisible(launched.page)
    const firstPty = await waitForActivePanePtyId(launched.page)
    // The variable keeps the printed lines out of the echoed command.
    await execInTerminal(launched.page, firstPty, `M=UNDO; seq -f "\${M}A-%04g" 1 ${LINES}`)
    await waitForTerminalOutput(launched.page, `UNDOA-${LINES}`, 30_000)
    // Pane A also holds an idle, resumable agent, as a hook-reporting Codex leaves it.
    const agentPane = await waitForActivePaneHookDescriptor(launched.page)
    const transcriptPath = session.seedCodexResumeRollout(UNDO_AGENT_SESSION, repoPath)
    await launched.page.evaluate(
      ({ paneKey, worktreeId: wtId, providerSessionId, transcriptPath }) => {
        window.__store
          ?.getState()
          .setAgentStatus(
            paneKey,
            { state: 'done', prompt: 'finish the task', agentType: 'codex' },
            'Codex',
            undefined,
            { worktreeId: wtId },
            { providerSession: { key: 'session_id', id: providerSessionId, transcriptPath } }
          )
      },
      {
        paneKey: agentPane.paneKey,
        worktreeId: agentPane.worktreeId,
        providerSessionId: UNDO_AGENT_SESSION,
        transcriptPath
      }
    )
    await splitActiveTerminalPane(launched.page, 'vertical')
    await waitForPaneCount(launched.page, 2, 30_000)
    const secondPty = await waitForActivePanePtyId(launched.page)
    expect(secondPty).not.toBe(firstPty)
    await execInTerminal(launched.page, secondPty, `M=UNDO; seq -f "\${M}B-%04g" 1 ${LINES}`)
    await waitForTerminalOutput(launched.page, `UNDOB-${LINES}`, 30_000)
    // The move's pause is main's own Sleep: it keeps each pane's identity and final checkpoint.
    const slept = await launched.page.evaluate(
      (id) =>
        window.api.runtime.call({ method: 'worktree.sleep', params: { worktree: `id:${id}` } }),
      worktreeId
    )
    expect(slept.ok).toBe(true)
    await expect
      .poll(
        () =>
          launched!.page.evaluate((id) => {
            const state = window.__store!.getState()
            return (state.tabsByWorktree[id] ?? []).reduce(
              (n, tab) => n + (state.ptyIdsByTabId[tab.id]?.length ?? 0),
              0
            )
          }, worktreeId),
        { timeout: 30_000 }
      )
      .toBe(0)
    const repoId = worktreeId.split('::')[0]
    await session.close(launched.app)
    launched = undefined
    // Hermetic resume: the agent command echoes its arguments instead of running Codex.
    mutateStoppedProfileState(session.userDataDir, (state) => {
      const session = SessionWithAgentRecords.parse(state.workspaceSession)
      const records = session.sleepingAgentSessionsByPaneKey ?? {}
      const paneKey = Object.keys(records).find(
        (key) => records[key]?.providerSession?.id === UNDO_AGENT_SESSION
      )
      const record = paneKey ? records[paneKey] : undefined
      if (!paneKey || !record) {
        throw new Error('the pause kept no resumable agent for pane A')
      }
      state.workspaceSession = {
        ...session,
        sleepingAgentSessionsByPaneKey: {
          ...records,
          [paneKey]: {
            ...record,
            launchConfig: { agentCommand: 'echo', agentArgs: '', agentEnv: {} }
          }
        }
      }
    })

    // The move committed: startup runs its desktop rewrite and retention, as after a real move.
    seedWslMoveCutover(
      session.userDataDir,
      wslMoveCutoverFixture('move-1', 'destination-committed', {}, { repoIds: [repoId] })
    )
    // Moved: the window reloads three times and the app restarts once before the undo.
    launched = await session.launch()
    await waitForSessionReady(launched.page)
    for (let reload = 0; reload < 3; reload += 1) {
      await launched.page.reload()
      await waitForSessionReady(launched.page)
    }
    await session.close(launched.app)
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

    // Back here as a slept workspace: nothing runs until it is opened...
    const livePtys = (): Promise<number> =>
      page.evaluate((id) => {
        const state = window.__store!.getState()
        return (state.tabsByWorktree[id] ?? []).reduce(
          (n, tab) => n + (state.ptyIdsByTabId[tab.id]?.length ?? 0),
          0
        )
      }, worktreeId)
    expect(await livePtys()).toBe(0)
    // ...and opening it wakes both panes from their checkpoints.
    await page.evaluate((id) => window.__store!.getState().setActiveWorktree(id), worktreeId)
    await ensureTerminalVisible(page)
    await waitForPaneCount(page, 2, 60_000)
    const readPanes = (): Promise<string[]> =>
      page.evaluate(() => {
        const state = window.__store!.getState()
        const manager = state.activeTabId ? window.__paneManagers?.get(state.activeTabId) : null
        return (manager?.getPanes?.() ?? []).map((pane) => pane.serializeAddon?.serialize?.() ?? '')
      })
    await expect
      .poll(
        async () =>
          (await readPanes()).map((text) =>
            ['UNDOA', 'UNDOB'].filter((marker) => text.includes(`${marker}-${LINES}`)).join()
          ),
        { timeout: 60_000, message: 'a woken pane never showed its history' }
      )
      .toEqual(['UNDOA', 'UNDOB'])
    for (const [index, text] of (await readPanes()).entries()) {
      const marker = ['UNDOA', 'UNDOB'][index]
      console.log(
        `[restore-lifecycle] undo ${marker}: first=${count(text, `${marker}-0001`)} last=${count(text, `${marker}-${LINES}`)}`
      )
      expect.soft(count(text, `${marker}-${LINES}`)).toBe(1)
    }
    // Live panes: what is typed in each now runs there.
    const ptyIds = await page.evaluate(() => {
      const state = window.__store!.getState()
      return state.activeTabId ? (state.ptyIdsByTabId[state.activeTabId] ?? []) : []
    })
    expect(ptyIds).toHaveLength(2)
    for (const [index, ptyId] of ptyIds.entries()) {
      await execInTerminal(page, ptyId, `echo "ALIVE-${index}-$((40 + 2))"`)
    }
    await expect
      .poll(async () => (await readPanes()).filter((text) => /ALIVE-\d-42/.test(text)).length, {
        timeout: 30_000,
        message: 'a woken pane did not run what was typed'
      })
      .toBe(2)
    // Pane A's agent resumed there, once; pane B started no agent.
    const panes = await readPanes()
    expect.soft(count(panes[0] ?? '', UNDO_AGENT_SESSION)).toBeGreaterThan(0)
    expect.soft(count(panes[1] ?? '', UNDO_AGENT_SESSION)).toBe(0)
    const resumeTabs = await page.evaluate(
      (id) => (window.__store!.getState().tabsByWorktree[id] ?? []).length,
      worktreeId
    )
    expect.soft(resumeTabs).toBe(1)
  } finally {
    if (launched) {
      await session.close(launched.app)
    }
    await session.dispose()
    rmSync(root, { recursive: true, force: true })
  }
})
