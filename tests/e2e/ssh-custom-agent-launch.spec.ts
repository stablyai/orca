import path from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import type { CustomTuiAgent, CustomTuiAgentId } from '../../src/shared/types'
import { test, expect } from './helpers/orca-app'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  countVisibleTerminalPanes,
  sendToTerminal,
  waitForActivePanePtyId,
  waitForActiveTerminalManager,
  waitForPaneCount,
  waitForTerminalOutput
} from './helpers/terminal'
import {
  cleanupDockerSshRelayTarget,
  startDockerSshRelayTarget,
  type DockerSshRelayTarget
} from './helpers/docker-ssh-relay-target'
import {
  connectDockerRemoteWorktree,
  observeRemoteAgentProcesses,
  placeCustomAgentFixtureInContainer,
  reconnectDockerTarget,
  REMOTE_CUSTOM_AGENT_FIXTURE_PATH
} from './helpers/docker-ssh-custom-agent-remote'

const RUN_DOCKER_SSH = process.env.ORCA_E2E_SSH_DOCKER === '1'
const LOCAL_FIXTURE_PATH = path.join(
  process.cwd(),
  'tests/e2e/fixtures/custom-agent-launch-fixture.cjs'
)
const CUSTOM_AGENT_ID =
  'custom-agent:codex:2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e' as CustomTuiAgentId
const CUSTOM_AGENT_LABEL = 'E2E SSH Fixture Agent'
const READY_MARKER = 'CUSTOM_AGENT_FIXTURE_READY'
// A declared env value that no base agent, shell profile, or relay would set on
// its own, so finding it in the remote /proc/<pid>/environ proves the host
// carried THIS custom agent's env across the relay to the spawned process. The
// key must avoid the reserved ORCA_* namespace (rejected by field validation).
const ENV_MARKER_KEY = 'E2E_CUSTOM_MARKER'
const ENV_MARKER_VALUE = 'orca-remote-env-proof'

// The custom executable is `node <fixture>` where the fixture lives INSIDE the
// container: commandOverride is a bare `node` resolved on the remote PATH (the
// node:22 image ships it), and the space-free container path rides the v1 args
// template as one argument. The host resolves and spawns this on the remote.
const CUSTOM_AGENT: CustomTuiAgent = {
  id: CUSTOM_AGENT_ID,
  baseAgent: 'codex',
  label: CUSTOM_AGENT_LABEL,
  commandOverride: 'node',
  args: REMOTE_CUSTOM_AGENT_FIXTURE_PATH,
  env: { [ENV_MARKER_KEY]: ENV_MARKER_VALUE },
  syncEnv: false
}

test.use({ seededCustomAgents: { agents: [CUSTOM_AGENT] } })

async function launchSeededCustomAgent(page: Page, worktreeId: string): Promise<string> {
  // Same production boundary as launchAgentInNewTab: an empty command with an
  // agentLaunch selection the host resolves at spawn (it owns command/arg/env
  // assembly), driving the seeded commandOverride into the remote PTY.
  return await page.evaluate(
    ({ worktreeId, agentId }) => {
      const store = window.__store
      if (!store) {
        throw new Error('Store unavailable')
      }
      const state = store.getState()
      const tab = state.createTab(worktreeId, undefined, undefined, { launchAgent: agentId })
      state.queueTabStartupCommand(tab.id, {
        command: '',
        agentLaunch: {
          selection: { kind: 'agent', agent: agentId },
          allowEmptyPromptLaunch: true
        },
        telemetry: { launch_source: 'tab_bar_quick_launch', request_kind: 'new' }
      })
      state.setActiveTab(tab.id)
      state.setActiveTabType('terminal')
      return tab.id
    },
    { worktreeId, agentId: CUSTOM_AGENT_ID }
  )
}

test.describe('SSH custom-agent launch', () => {
  test.skip(!RUN_DOCKER_SSH, 'Set ORCA_E2E_SSH_DOCKER=1 to run Docker-backed SSH custom-agent e2e.')
  test.skip(process.platform === 'win32', 'Docker SSH custom-agent e2e uses POSIX ssh tooling.')

  test('resolves and spawns a seeded custom agent on the SSH remote with the exact argv and env', async ({
    orcaPage
  }, testInfo) => {
    test.slow()
    let target: DockerSshRelayTarget | null = null
    try {
      target = startDockerSshRelayTarget(testInfo)
      placeCustomAgentFixtureInContainer(target, LOCAL_FIXTURE_PATH)

      await waitForSessionReady(orcaPage)
      await waitForActiveWorktree(orcaPage)

      // Self-verify the seed loaded into the real host catalog before launching,
      // so schema drift fails loudly here instead of silently no-op'ing.
      const loadedAgent = await orcaPage.evaluate(async (agentId) => {
        const snapshot = await window.api.settings.agentCatalog.getLocal()
        const entry = snapshot.customAgents.find(
          (candidate) => candidate.status === 'ready' && candidate.definition.id === agentId
        )
        return entry && entry.status === 'ready'
          ? { id: entry.definition.id, label: entry.definition.label }
          : null
      }, CUSTOM_AGENT_ID)
      expect(loadedAgent).toEqual({ id: CUSTOM_AGENT_ID, label: CUSTOM_AGENT_LABEL })

      const remote = await connectDockerRemoteWorktree(orcaPage, target)
      const launchedTabId = await launchSeededCustomAgent(orcaPage, remote.worktreeId)

      await ensureTerminalVisible(orcaPage, 45_000)
      await waitForActiveTerminalManager(orcaPage, 60_000)
      await waitForPaneCount(orcaPage, 1, 60_000)
      const ptyId = await waitForActivePanePtyId(orcaPage, 60_000)

      // The fixture prints its readiness marker on spawn: the host resolved the
      // custom executable and started it in the REMOTE pane's PTY.
      await waitForTerminalOutput(orcaPage, READY_MARKER, 60_000, 80_000)

      // Observe the real remote process: exactly one node agent, launched with
      // the host-assembled argv (the container fixture path) and carrying the
      // custom agent's declared env — read from /proc inside the container.
      await expect
        .poll(() => observeRemoteAgentProcesses(target!).length, {
          timeout: 30_000,
          message: 'remote custom-agent process did not appear in the container'
        })
        .toBe(1)
      const [remoteProcess] = observeRemoteAgentProcesses(target)
      expect(remoteProcess.argv).toContain(REMOTE_CUSTOM_AGENT_FIXTURE_PATH)
      expect(remoteProcess.env.get(ENV_MARKER_KEY)).toBe(ENV_MARKER_VALUE)

      // Trusted keyboard input reaches THIS remote process, which echoes it back
      // with a prefix the terminal never produces (raw mode, no local echo).
      await sendToTerminal(orcaPage, ptyId, 'ping\r')
      await waitForTerminalOutput(orcaPage, 'CUSTOM_AGENT_ECHO:ping', 30_000, 80_000)

      // Exactly one PTY/identity: one pane, and the tab carries the custom
      // agent's identity as its visible launch state.
      expect(await countVisibleTerminalPanes(orcaPage)).toBe(1)
      const tabIdentity = await orcaPage.evaluate(
        ({ worktreeId, tabId }) => {
          const tab = (window.__store?.getState().tabsByWorktree[worktreeId] ?? []).find(
            (candidate) => candidate.id === tabId
          )
          return tab ? { launchAgent: tab.launchAgent, ptyId: tab.ptyId } : null
        },
        { worktreeId: remote.worktreeId, tabId: launchedTabId }
      )
      expect(tabIdentity?.launchAgent).toBe(CUSTOM_AGENT_ID)
      expect(typeof tabIdentity?.ptyId).toBe('string')

      testInfo.annotations.push({
        type: 'ssh-custom-agent-launch',
        description: `remote pid=${remoteProcess.pid} argv=${remoteProcess.argv.join(' ')}`
      })

      await sendToTerminal(orcaPage, ptyId, '\x03')
    } finally {
      cleanupDockerSshRelayTarget(target)
    }
  })

  test('settles the launch token after a relay disconnect/reconnect without a duplicate remote agent', async ({
    orcaPage
  }, testInfo) => {
    test.slow()
    let target: DockerSshRelayTarget | null = null
    try {
      target = startDockerSshRelayTarget(testInfo)
      placeCustomAgentFixtureInContainer(target, LOCAL_FIXTURE_PATH)

      await waitForSessionReady(orcaPage)
      await waitForActiveWorktree(orcaPage)
      const remote = await connectDockerRemoteWorktree(orcaPage, target)
      await launchSeededCustomAgent(orcaPage, remote.worktreeId)

      await ensureTerminalVisible(orcaPage, 45_000)
      await waitForActiveTerminalManager(orcaPage, 60_000)
      await waitForActivePanePtyId(orcaPage, 60_000)
      await waitForTerminalOutput(orcaPage, READY_MARKER, 60_000, 80_000)
      await expect
        .poll(() => observeRemoteAgentProcesses(target!).length, { timeout: 30_000 })
        .toBe(1)

      // Kill and re-establish the relay. Recovery must never guess liveness or
      // identity into a SECOND launch, and reattach must preserve the live
      // remote process: exactly one agent survives — no duplicate, no respawn,
      // and no kill of the original.
      await reconnectDockerTarget(orcaPage, remote.targetId)
      await ensureTerminalVisible(orcaPage, 45_000)
      await waitForActiveTerminalManager(orcaPage, 60_000)

      await expect
        .poll(() => observeRemoteAgentProcesses(target!).length, {
          timeout: 30_000,
          message:
            'reconnect must preserve exactly one remote custom-agent process (no duplicate, no kill)'
        })
        .toBe(1)

      testInfo.annotations.push({
        type: 'ssh-custom-agent-reconnect-settle',
        description: `remote agents after reconnect: ${observeRemoteAgentProcesses(target).length}`
      })
    } finally {
      cleanupDockerSshRelayTarget(target)
    }
  })
})
