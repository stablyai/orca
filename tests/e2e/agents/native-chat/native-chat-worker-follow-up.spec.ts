import { readFileSync, writeFileSync } from 'node:fs'
import type { ElectronApplication } from '@stablyai/playwright-test'
import { expect } from '@stablyai/playwright-test'
import { test } from '../../desktop/electron-fixtures/orca-app'
import {
  attachRepoAndOpenTerminal,
  createRestartSession
} from '../../desktop/electron-fixtures/orca-restart'
import { waitForActiveWorktree, waitForSessionReady } from '../../desktop/renderer-probes/store'
import { seedWorkerFollowUpProfile } from './worker-follow-up-profile'
import { TEST_REPO_PATH_FILE } from '../../global-setup'
import { RuntimeClient } from '../../../../src/cli/runtime/client'
import {
  sessionWorkerIsRunning,
  type OrchestrationSessionWorkersResult
} from '../../../../src/shared/orchestration-session-workers'

// oxlint-disable-next-line no-empty-pattern -- This test owns its two isolated app launches.
test('native chat retains worker providers after restart and successive follow-ups', async ({}, testInfo) => {
  const session = createRestartSession(testInfo, { ORCA_BACKGROUND_LAUNCH: '1' })
  let app: ElectronApplication | undefined
  try {
    const initial = await session.launch()
    app = initial.app
    const worktreeId = await attachRepoAndOpenTerminal(
      initial.page,
      readFileSync(TEST_REPO_PATH_FILE, 'utf8').trim()
    )
    await waitForSessionReady(initial.page)
    await session.close(app)
    app = undefined
    const seeded = await seedWorkerFollowUpProfile(session.userDataDir, worktreeId)
    const current = await session.launch()
    app = current.app
    await current.page.setViewportSize({ width: 1280, height: 900 })
    await waitForSessionReady(current.page)
    await waitForActiveWorktree(current.page)
    const client = new RuntimeClient(session.userDataDir, 30_000, null, null)
    await client.call('session.tabs.list', { worktree: `id:${worktreeId}` })
    await client.call('session.tabs.activate', {
      worktree: `id:${worktreeId}`,
      tabId: `agent-session:${seeded.coordinator}`
    })
    const identity = await app.evaluate(({ app, BrowserWindow }) => ({
      appPath: app.getAppPath(),
      userData: app.getPath('userData'),
      windows: BrowserWindow.getAllWindows().map((window) => ({
        visible: window.isVisible(),
        focused: window.isFocused()
      }))
    }))
    expect(identity.appPath).toBe(process.cwd())
    expect(identity.userData).toBe(session.userDataDir)
    expect(identity.windows.every((window) => !window.visible && !window.focused)).toBe(true)
    const workers = await current.page.evaluate(async (coordinator) => {
      const result = await window.api.runtime.call({
        method: 'orchestration.sessionWorkers',
        params: { session: coordinator }
      })
      if (!result.ok) {
        throw new Error(JSON.stringify(result.error))
      }
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Same-build RPC contract, checked by the assertions below.
      return (result.result as OrchestrationSessionWorkersResult).workers
    }, seeded.coordinator)
    const running = workers.filter(sessionWorkerIsRunning)
    expect(running).toHaveLength(3)
    const evidence = { identity, viewport: current.page.viewportSize(), workers }
    writeFileSync(testInfo.outputPath('projection.json'), JSON.stringify(evidence, null, 2))
    await current.page.screenshot({ path: testInfo.outputPath('worker-follow-up.png') })
    // Each follow-up still names the agent its first turn ran.
    for (const row of seeded.expected) {
      expect(running.find((worker) => worker.dispatchId === row.dispatchId)?.agent).toBe(row.agent)
    }
  } finally {
    await session.dispose(app)
  }
})
