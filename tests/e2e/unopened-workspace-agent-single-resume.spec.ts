// A never-visited CLI agent tab exists only in main’s layout. After quit/reboot-like daemon loss, first visit must resume once in its owning pane.
// Reject a second fresh-tab resume that would put two agents on one transcript.
import { chmodSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { RuntimeClient } from '../../src/cli/runtime-client'
import { makePaneKey } from '../../src/shared/stable-pane-id'
import { PROTOCOL_VERSION } from '../../src/main/daemon/types'
import { expect, test } from './helpers/orca-app'
import { TEST_REPO_PATH_FILE } from './global-setup'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { attachRepoAndOpenTerminal, createRestartSession } from './helpers/orca-restart'
import { mutateStoppedProfileState } from './helpers/persisted-profile-state'
import {
  createHostCliTerminal,
  createRetentionFixtureDirectory,
  writeRetentionFixture,
  type RuntimeRpcCall
} from './helpers/host-created-terminal-retention-oracle'

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

function workspaceSessionOf(state: Record<string, unknown>): Record<string, unknown> {
  const session = state.workspaceSession
  if (!session || typeof session !== 'object') {
    throw new Error('stopped profile has no workspace session')
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: checked to be a non-null object above; the test writes one map on it.
  return session as Record<string, unknown>
}

const scratch = createRetentionFixtureDirectory()
const fixturePath = writeRetentionFixture(scratch)
test.afterAll(() => rmSync(scratch, { recursive: true, force: true }))

// oxlint-disable-next-line no-empty-pattern -- Owns both app launches; Playwright needs the fixtures argument.
test('a sleeping agent in a never-opened workspace resumes once, in its own pane', async ({}, testInfo) => {
  test.skip(process.platform === 'win32', 'Uses POSIX SIGKILL and a shell-script agent')
  test.setTimeout(400_000)
  const repoPath = readFileSync(TEST_REPO_PATH_FILE, 'utf-8').trim()
  const dir = testInfo.outputPath()
  const fakeAgent = path.join(dir, 'fake-agent.sh')
  const resumeLog = path.join(dir, 'resumes.log')
  writeFileSync(resumeLog, '')
  // Each resume appends the pane it ran in, so a second resume anywhere is visible.
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
    // The precondition: the window never held the tab, so only main's layout has the pane.
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
    // The record a quit capture leaves for a working agent, resumed through the logging stand-in.
    mutateStoppedProfileState(session.userDataDir, (state) => {
      const workspaceSession = workspaceSessionOf(state)
      const now = Date.now()
      const records = workspaceSession.sleepingAgentSessionsByPaneKey
      workspaceSession.sleepingAgentSessionsByPaneKey = {
        ...(records && typeof records === 'object' ? records : undefined),
        [paneKey]: {
          paneKey,
          worktreeId: unopened,
          agent: 'codex',
          providerSession: { key: 'session_id', id: sessionId },
          connectionId: null,
          prompt: 'keep working',
          state: 'working',
          capturedAt: now,
          updatedAt: now,
          origin: 'quit',
          launchConfig: { agentCommand: fakeAgent, agentArgs: '', agentEnv: {} }
        }
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
    await expect.poll(resumedPaneKeys, { timeout: 30_000 }).toEqual([paneKey])
    // The activation sweep runs within a second of the visit; give a second resume time to show.
    await second.page.waitForTimeout(5_000)
    expect(resumedPaneKeys()).toEqual([paneKey])
    expect(
      await second.page.evaluate(
        (worktreeId) =>
          (window.__store!.getState().tabsByWorktree[worktreeId] ?? []).map((tab) => tab.id),
        unopened
      )
    ).toEqual([cli.tabId])
  } finally {
    await session.close(app).catch(() => undefined)
    await session.dispose()
  }
})
