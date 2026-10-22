/**
 * A CLI-started agent in a workspace the window never opened resumes after a quit and relaunch.
 *
 * Its status reaches only the app's own agent-status server; the window never shows its tab. The
 * quit must still leave the agent's resume record on disk, and showing the tab after a relaunch
 * (with the terminal daemon gone, as after a reboot) must resume the agent.
 *
 * Run:
 *   pnpm exec playwright test tests/e2e/cli-agent-unopened-workspace-resume.spec.ts \
 *     --config tests/playwright.config.ts --project electron-headless --workers=1
 */
import { chmodSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { RuntimeClient } from '../../src/cli/runtime-client'
import { makePaneKey } from '../../src/shared/stable-pane-id'
import { PROTOCOL_VERSION } from '../../src/main/daemon/types'
import { expect, test } from './helpers/orca-app'
import { TEST_REPO_PATH_FILE } from './global-setup'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { attachRepoAndOpenTerminal, createRestartSession } from './helpers/orca-restart'
import { emitCodexHookStatus, readHookEndpoint } from './helpers/agent-hook-endpoint'
import {
  mutateStoppedProfileState,
  readPersistedProfileState
} from './helpers/persisted-profile-state'
import {
  createHostCliTerminal,
  createRetentionFixtureDirectory,
  writeRetentionFixture,
  type RuntimeRpcCall
} from './helpers/host-created-terminal-retention-oracle'

type SleepingRecords = Record<string, { launchConfig?: unknown }>

function sleepingRecords(state: unknown): SleepingRecords {
  if (!state || typeof state !== 'object' || !('workspaceSession' in state)) {
    return {}
  }
  const session: unknown = state.workspaceSession
  if (!session || typeof session !== 'object' || !('sleepingAgentSessionsByPaneKey' in session)) {
    return {}
  }
  const records: unknown = session.sleepingAgentSessionsByPaneKey
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the persisted map is keyed by pane key; the test reads only `launchConfig`.
  return records && typeof records === 'object' ? (records as SleepingRecords) : {}
}

function readDaemonPid(userDataDir: string): number {
  const raw = readFileSync(
    path.join(userDataDir, 'daemon', `daemon-v${PROTOCOL_VERSION}.pid`),
    'utf8'
  )
  const parsed: unknown = JSON.parse(raw)
  const pid = parsed && typeof parsed === 'object' && 'pid' in parsed ? parsed.pid : undefined
  if (typeof pid !== 'number') {
    throw new Error(`Daemon pid file did not contain a numeric pid: ${raw}`)
  }
  return pid
}

const scratch = createRetentionFixtureDirectory()
const fixturePath = writeRetentionFixture(scratch)
test.afterAll(() => rmSync(scratch, { recursive: true, force: true }))

// oxlint-disable-next-line no-empty-pattern -- Owns both app launches; Playwright needs the fixtures argument.
test('a CLI agent in a never-opened workspace resumes after quit and relaunch', async ({}, testInfo) => {
  test.setTimeout(400_000)
  const repoPath = readFileSync(TEST_REPO_PATH_FILE, 'utf-8').trim()
  const dir = testInfo.outputPath()
  const fakeAgent = path.join(dir, 'fake-agent.sh')
  const resumeLog = path.join(dir, 'resumes.log')
  writeFileSync(resumeLog, '')
  writeFileSync(
    fakeAgent,
    `#!/bin/sh\nprintf '%s\\n' "$ORCA_PANE_KEY" >> '${resumeLog}'\nexec sleep 3600\n`
  )
  chmodSync(fakeAgent, 0o755)
  const resumedPaneKeys = (): string[] =>
    readFileSync(resumeLog, 'utf8').split('\n').filter(Boolean)

  const session = createRestartSession(testInfo)
  let app = (await session.launch()).app
  try {
    const page = await app.firstWindow()
    const active = await attachRepoAndOpenTerminal(page, repoPath)
    await waitForSessionReady(page)
    const call: RuntimeRpcCall = async <T>(method: string, params: unknown) =>
      (await new RuntimeClient(session.userDataDir, 30_000, null, null).call<T>(method, params))
        .result
    await expect
      .poll(
        () =>
          page.evaluate(async () => {
            const state = window.__store!.getState()
            const repo = state.repos[0]!
            await state.updateRepo(repo.id, { externalWorktreeVisibility: 'show' })
            await window.__store!.getState().fetchWorktrees(repo.id)
            return window.__store!.getState().allWorktrees().length
          }),
        { timeout: 60_000 }
      )
      .toBeGreaterThan(1)
    const unopened = await page.evaluate(
      (activeId) =>
        window
          .__store!.getState()
          .allWorktrees()
          .find((worktree) => worktree.id !== activeId)!.id,
      active
    )
    for (const id of [active, unopened]) {
      await expect
        .poll(
          () =>
            call('worktree.show', { worktree: `id:${id}` }).then(
              () => true,
              () => false
            ),
          { timeout: 120_000 }
        )
        .toBe(true)
    }
    const cli = await createHostCliTerminal(
      call,
      unopened,
      fixturePath,
      path.join(scratch, 'unopened.log')
    )
    const paneKey = makePaneKey(cli.tabId, cli.leafId)
    const sessionId = `unopened-${Date.now()}`
    session.seedCodexResumeRollout(sessionId, repoPath)
    const endpoint = await readHookEndpoint(app)
    await emitCodexHookStatus(endpoint, {
      paneKey,
      worktreeId: unopened,
      state: 'working',
      prompt: 'keep working',
      sessionId
    })
    // The precondition: the window never holds the tab, so only main can keep its record.
    await expect
      .poll(() =>
        page.evaluate(
          (key) => window.__store!.getState().sleepingAgentSessionsByPaneKey[key] !== undefined,
          paneKey
        )
      )
      .toBe(true)
    expect(
      await page.evaluate(
        ({ worktreeId, tabId }) =>
          (window.__store!.getState().tabsByWorktree[worktreeId] ?? []).some(
            (tab) => tab.id === tabId
          ),
        { worktreeId: unopened, tabId: cli.tabId }
      )
    ).toBe(false)

    const daemonPid = readDaemonPid(session.userDataDir)
    await session.close(app)
    expect(Object.keys(sleepingRecords(readPersistedProfileState(session.userDataDir)))).toContain(
      paneKey
    )
    // Resume through a stand-in that logs its pane, so the resume is observable.
    mutateStoppedProfileState(session.userDataDir, (state) => {
      sleepingRecords(state)[paneKey]!.launchConfig = {
        agentCommand: fakeAgent,
        agentArgs: '',
        agentEnv: {}
      }
    })
    // As after a reboot: the agent's terminal is gone, so only the record can bring it back.
    process.kill(daemonPid, 'SIGKILL')

    const second = await session.launch()
    app = second.app
    await waitForSessionReady(second.page)
    await waitForActiveWorktree(second.page)
    await second.page.evaluate(
      (worktreeId) => window.__store!.getState().setActiveWorktree(worktreeId),
      unopened
    )
    await expect
      .poll(
        () =>
          second.page.evaluate(
            ({ worktreeId, tabId }) =>
              (window.__store!.getState().tabsByWorktree[worktreeId] ?? []).some(
                (tab) => tab.id === tabId
              ),
            { worktreeId: unopened, tabId: cli.tabId }
          ),
        { timeout: 30_000 }
      )
      .toBe(true)
    await second.page.evaluate((tabId) => {
      const state = window.__store!.getState()
      state.setActiveTab(tabId)
      state.setActiveTabType('terminal', state.activeWorktreeId)
    }, cli.tabId)
    await expect.poll(resumedPaneKeys, { timeout: 30_000 }).toEqual([paneKey])
  } finally {
    await session.close(app).catch(() => undefined)
    await session.dispose()
  }
})
