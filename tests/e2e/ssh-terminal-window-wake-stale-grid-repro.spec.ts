import type { Page } from '@stablyai/playwright-test'
import path from 'node:path'
import { test, expect } from './helpers/orca-app'
import { connectDockerSshRelayTarget } from './helpers/docker-ssh-relay-connection'
import {
  cleanupDockerSshRelayTarget,
  DOCKER_SSH_RELAY_REMOTE_REPO_PATH,
  execDockerSshRelayTargetCommand,
  startDockerSshRelayTarget,
  type DockerSshRelayTarget
} from './helpers/docker-ssh-relay-target'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  execInTerminal,
  waitForActivePanePtyId,
  waitForActiveTerminalManager,
  waitForTerminalOutput
} from './helpers/terminal'
import {
  actualGridMatchesXterm,
  attachStaleGridEvidence,
  installIdleGridMonitor,
  readRemoteGrid,
  readRendererGrid,
  REMOTE_MONITOR_PATH,
  REMOTE_STATE_PATH,
  sampleRemoteConvergence,
  type Grid
} from './ssh-terminal-stale-grid-probe'

const RUN_DOCKER_SSH = process.env.ORCA_E2E_SSH_DOCKER === '1'
const BASE_VIEWPORT = { width: 1160, height: 760 }

async function startRemoteMonitor(page: Page, ptyId: string): Promise<void> {
  const marker = `ORCA_SSH_WAKE_READY_${Date.now()}`
  await execInTerminal(page, ptyId, `printf '${marker}\\n'`)
  await waitForTerminalOutput(page, marker, 20_000, 60_000)
  await execInTerminal(page, ptyId, `node ${REMOTE_MONITOR_PATH} ${REMOTE_STATE_PATH}`)
}

function chooseStaleGrid(current: Grid): Grid {
  return {
    cols: Math.max(40, current.cols - 19),
    rows: Math.max(12, current.rows - 7)
  }
}

test.describe('SSH terminal window-wake stale PTY grid repro', () => {
  test.skip(!RUN_DOCKER_SSH, 'Set ORCA_E2E_SSH_DOCKER=1 to run Docker-backed SSH repro.')
  test.skip(process.platform === 'win32', 'Docker SSH repro uses POSIX SSH tooling.')

  test('window focus heals a remote PTY whose applied grid drifted from xterm', async ({
    orcaPage
  }, testInfo) => {
    test.setTimeout(240_000)
    let target: DockerSshRelayTarget | null = null
    try {
      target = startDockerSshRelayTarget(testInfo)
      const pageErrors: string[] = []
      orcaPage.on('pageerror', (error) => pageErrors.push(error.message))
      installIdleGridMonitor(target)
      await orcaPage.setViewportSize(BASE_VIEWPORT)
      await waitForSessionReady(orcaPage)
      await waitForActiveWorktree(orcaPage)
      const identity = await orcaPage.evaluate(() => window.api.app.getIdentity())
      expect(identity.isDev).toBe(true)
      expect(identity.devWorktreeName).toBe(path.basename(process.cwd()))

      await connectDockerSshRelayTarget(orcaPage, target, { relayGracePeriodSeconds: 300 })
      await ensureTerminalVisible(orcaPage, 60_000)
      await waitForActiveTerminalManager(orcaPage, 60_000)
      const ptyId = await waitForActivePanePtyId(orcaPage, 60_000)
      await startRemoteMonitor(orcaPage, ptyId)
      await expect
        .poll(
          () => {
            try {
              return readRemoteGrid(target!).pid > 0
            } catch {
              return false
            }
          },
          { timeout: 30_000, message: 'Idle remote grid monitor did not start' }
        )
        .toBe(true)

      await expect
        .poll(
          async () =>
            actualGridMatchesXterm(
              readRemoteGrid(target!),
              await readRendererGrid(orcaPage, ptyId)
            ),
          { timeout: 15_000, message: 'Remote PTY and xterm did not establish a matching baseline' }
        )
        .toBe(true)

      const baseline = await readRendererGrid(orcaPage, ptyId)
      if (!baseline.xterm) {
        throw new Error('Active xterm grid unavailable')
      }
      const staleGrid = chooseStaleGrid(baseline.xterm)
      await orcaPage.evaluate(({ id, grid }) => window.api.pty.resize(id, grid.cols, grid.rows), {
        id: ptyId,
        grid: staleGrid
      })
      await expect.poll(() => readRemoteGrid(target!).cols, { timeout: 5_000 }).toBe(staleGrid.cols)
      await expect.poll(() => readRemoteGrid(target!).rows, { timeout: 5_000 }).toBe(staleGrid.rows)

      const drifted = await readRendererGrid(orcaPage, ptyId)
      expect(drifted.xterm).toEqual(baseline.xterm)
      expect(drifted.applied).toEqual(staleGrid)

      await orcaPage.evaluate(() => window.dispatchEvent(new Event('focus')))
      const wakeResult = await sampleRemoteConvergence({
        cycle: 0,
        page: orcaPage,
        ptyId,
        target,
        timeoutMs: 3_000
      })

      if (!actualGridMatchesXterm(wakeResult.last.remote, wakeResult.last.renderer)) {
        await attachStaleGridEvidence(
          orcaPage,
          testInfo,
          'ssh-window-focus-stale-grid',
          wakeResult.stale
        )
        // Manual resize is the field workaround and proves the remote channel
        // can still deliver the corrective SIGWINCH.
        await orcaPage.setViewportSize({
          width: BASE_VIEWPORT.width + 24,
          height: BASE_VIEWPORT.height + 24
        })
        const manualResize = await sampleRemoteConvergence({
          cycle: 1,
          page: orcaPage,
          ptyId,
          target,
          timeoutMs: 6_000
        })
        expect(actualGridMatchesXterm(manualResize.last.remote, manualResize.last.renderer)).toBe(
          true
        )
      }

      expect(
        actualGridMatchesXterm(wakeResult.last.remote, wakeResult.last.renderer),
        `Window-focus recovery left the Linux PTY stale: ${JSON.stringify(wakeResult.last)}`
      ).toBe(true)
      expect(pageErrors).toEqual([])

      const remoteGitStatus = execDockerSshRelayTargetCommand(
        target,
        `git -C ${DOCKER_SSH_RELAY_REMOTE_REPO_PATH} status --short --branch`
      )
      const remoteWorktrees = execDockerSshRelayTargetCommand(
        target,
        `git -C ${DOCKER_SSH_RELAY_REMOTE_REPO_PATH} worktree list --porcelain`
      )
      expect(remoteGitStatus).toContain('## master')
      expect(remoteWorktrees).toContain(DOCKER_SSH_RELAY_REMOTE_REPO_PATH)
      expect(
        execDockerSshRelayTargetCommand(
          target,
          `kill -0 ${wakeResult.last.remote.pid} && printf alive`
        )
      ).toBe('alive')

      const evidence = {
        identity,
        target: { containerName: target.containerName, port: target.port },
        baseline,
        injectedRemoteGrid: staleGrid,
        recovered: wakeResult.last,
        remoteGitStatus,
        remoteWorktrees
      }
      console.log(`[ssh-window-wake-stale-grid] ${JSON.stringify(evidence)}`)
      testInfo.annotations.push({
        type: 'ssh-window-wake-stale-grid',
        description: JSON.stringify(evidence)
      })
      const healedScreenshot = testInfo.outputPath('ssh-window-focus-healed.png')
      await orcaPage.screenshot({ path: healedScreenshot, fullPage: true })
      await testInfo.attach('ssh-window-focus-healed.png', {
        path: healedScreenshot,
        contentType: 'image/png'
      })
    } finally {
      cleanupDockerSshRelayTarget(target)
    }
  })
})
