import type { Page } from '@stablyai/playwright-test'
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
  installIdleGridMonitor,
  readRemoteGrid,
  readRendererGrid,
  REMOTE_MONITOR_PATH,
  REMOTE_STATE_PATH,
  type Grid
} from './ssh-terminal-stale-grid-probe'

const RUN_DOCKER_SSH = process.env.ORCA_E2E_SSH_DOCKER === '1'

// Why: the relay clamps resize to [1, 500], so drift outside that range is never observable.
const PTY_DIMENSION_MAX = 500

// Why: drift must differ from the client grid, or reattach adopting it proves nothing.
function driftDimension(value: number, delta: number, min: number): number {
  const shrunk = value - delta
  return Math.min(shrunk >= min ? shrunk : value + delta, PTY_DIMENSION_MAX)
}

function staleGrid(grid: Grid): Grid {
  return { cols: driftDimension(grid.cols, 19, 40), rows: driftDimension(grid.rows, 7, 12) }
}

async function startGridMonitor(page: Page, ptyId: string): Promise<void> {
  await execInTerminal(page, ptyId, `node ${REMOTE_MONITOR_PATH} ${REMOTE_STATE_PATH}`)
}

test.describe('SSH PTY viewport reattach', () => {
  test.skip(!RUN_DOCKER_SSH, 'Set ORCA_E2E_SSH_DOCKER=1 to run Docker-backed SSH repro.')
  test.skip(process.platform === 'win32', 'Docker SSH repro uses POSIX SSH tooling.')

  test('@headful tab restore applies the visible client grid to the remote PTY', async ({
    orcaPage
  }, testInfo) => {
    test.setTimeout(240_000)
    let target: DockerSshRelayTarget | null = null
    try {
      target = startDockerSshRelayTarget(testInfo)
      installIdleGridMonitor(target)
      await orcaPage.setViewportSize({ width: 1160, height: 760 })
      await waitForSessionReady(orcaPage)
      await waitForActiveWorktree(orcaPage)
      const identity = await orcaPage.evaluate(() => window.api.app.getIdentity())
      const remote = await connectDockerSshRelayTarget(orcaPage, target, {
        relayGracePeriodSeconds: 300
      })
      await ensureTerminalVisible(orcaPage, 60_000)
      await waitForActiveTerminalManager(orcaPage, 60_000)
      const ptyId = await waitForActivePanePtyId(orcaPage, 60_000)
      await startGridMonitor(orcaPage, ptyId)
      await expect
        .poll(() => readRemoteGrid(target!).pid, {
          timeout: 30_000,
          message: 'Remote grid monitor did not start'
        })
        .toBeGreaterThan(0)

      const renderer = await readRendererGrid(orcaPage, ptyId)
      if (!renderer.xterm) {
        throw new Error('Visible SSH xterm grid unavailable')
      }
      const drift = staleGrid(renderer.xterm)
      expect(drift).not.toEqual(renderer.xterm)
      await orcaPage.evaluate(({ id, grid }) => window.api.pty.resize(id, grid.cols, grid.rows), {
        id: ptyId,
        grid: drift
      })
      await expect
        .poll(
          () => {
            const grid = readRemoteGrid(target!)
            return { cols: grid.cols, rows: grid.rows }
          },
          { timeout: 30_000, message: 'Injected drift did not reach the remote child' }
        )
        .toEqual(drift)
      const beforeReattach = readRemoteGrid(target)

      await orcaPage.evaluate(() => window.dispatchEvent(new Event('beforeunload')))
      await expect
        .poll(
          () =>
            orcaPage.evaluate(
              async ({ targetId, worktreeId }) => {
                const persisted = await window.api.session.get()
                return (
                  persisted.activeConnectionIdsAtShutdown?.includes(targetId) === true &&
                  persisted.tabsByWorktree[worktreeId]?.length > 0
                )
              },
              { targetId: remote.targetId, worktreeId: remote.worktreeId }
            ),
          { timeout: 10_000, message: 'SSH restore state was not persisted before reload' }
        )
        .toBe(true)
      await orcaPage.reload()
      await waitForSessionReady(orcaPage, 60_000)
      await expect
        .poll(() => waitForActiveWorktree(orcaPage), { timeout: 60_000 })
        .toBe(remote.worktreeId)
      await expect
        .poll(
          () =>
            orcaPage.evaluate(
              (targetId) => window.__store?.getState().sshConnectionStates.get(targetId)?.status,
              remote.targetId
            ),
          { timeout: 60_000, message: 'Renderer SSH state did not restore' }
        )
        .toBe('connected')
      await waitForActiveTerminalManager(orcaPage, 60_000)
      expect(await waitForActivePanePtyId(orcaPage, 60_000)).toBe(ptyId)
      const restoredRenderer = await readRendererGrid(orcaPage, ptyId)
      if (!restoredRenderer.xterm) {
        throw new Error('Restored SSH xterm grid unavailable')
      }
      await expect
        .poll(
          () => {
            const grid = readRemoteGrid(target!)
            return { cols: grid.cols, rows: grid.rows }
          },
          { timeout: 10_000, message: 'Restored viewport did not resize the remote child' }
        )
        .toEqual({ cols: restoredRenderer.xterm.cols, rows: restoredRenderer.xterm.rows })
      expect(readRemoteGrid(target).winches).toBeGreaterThan(beforeReattach.winches)
      await waitForTerminalOutput(
        orcaPage,
        `REMOTE_BOTTOM_BAR rows=${restoredRenderer.xterm.rows} cols=${restoredRenderer.xterm.cols}`,
        10_000,
        80_000
      )
      expect((await readRendererGrid(orcaPage, ptyId)).xterm).toEqual(restoredRenderer.xterm)

      const remoteGitStatus = execDockerSshRelayTargetCommand(
        target,
        `git -C ${DOCKER_SSH_RELAY_REMOTE_REPO_PATH} status --short --branch`
      )
      expect(remoteGitStatus).toContain('## master')
      const evidence = {
        identity,
        target: { containerIp: target.containerIp, host: target.host, port: target.port },
        ptyId,
        rendererBefore: renderer.xterm,
        rendererAfter: restoredRenderer.xterm,
        injected: drift,
        beforeReattach,
        afterReattach: readRemoteGrid(target),
        remoteGitStatus
      }
      console.log(`[ssh-pty-reattach-grid] ${JSON.stringify(evidence)}`)
      testInfo.annotations.push({
        type: 'ssh-pty-reattach-grid',
        description: JSON.stringify(evidence)
      })
      await testInfo.attach('ssh-pty-reattach-grid.png', {
        body: await orcaPage.screenshot({ fullPage: true }),
        contentType: 'image/png'
      })
    } finally {
      cleanupDockerSshRelayTarget(target)
    }
  })
})
