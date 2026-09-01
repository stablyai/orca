import path from 'node:path'
import type { CustomTuiAgent, CustomTuiAgentId } from '../../src/shared/types'
import { test, expect } from './helpers/orca-app'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  sendToTerminal,
  waitForActivePanePtyId,
  waitForActiveTerminalManager,
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
  REMOTE_CUSTOM_AGENT_FIXTURE_PATH
} from './helpers/docker-ssh-custom-agent-remote'
import { ARGV_PREFIX, launchCustomAgentViaBoundary, READY_MARKER } from './helpers/custom-agent-e2e'

// SSH variants of the non-terminal launch surfaces (Cmd+N composer, git actions).
// The launch surfaces converge on the same host boundary as the new-tab path, so
// these prove the surface-specific params (launch_source, sourceRecord agentArgs)
// resolve and spawn the custom agent on the REMOTE, observed via /proc in the
// container — a mocked handler could never see the real remote argv.
const RUN_DOCKER_SSH = process.env.ORCA_E2E_SSH_DOCKER === '1'
const LOCAL_FIXTURE_PATH = path.join(
  process.cwd(),
  'tests/e2e/fixtures/custom-agent-launch-fixture.cjs'
)
const CUSTOM_AGENT_ID =
  'custom-agent:codex:7a8b9c0d-1e2f-4a3b-8c4d-5e6f70819203' as CustomTuiAgentId
const CUSTOM_AGENT_LABEL = 'E2E SSH Surface Agent'

// The custom executable is `node <remote fixture>`: commandOverride is a bare
// `node` resolved on the remote PATH; the space-free container path rides the v1
// args template as one argument. The host resolves and spawns this on the remote.
const CUSTOM_AGENT: CustomTuiAgent = {
  id: CUSTOM_AGENT_ID,
  baseAgent: 'codex',
  label: CUSTOM_AGENT_LABEL,
  commandOverride: 'node',
  args: REMOTE_CUSTOM_AGENT_FIXTURE_PATH,
  env: {},
  syncEnv: false
}

// A source-control recipe whose stored agentArgs the host threads into the remote
// launch's perLaunchArgs when a git-action launch names it via sourceRecord.
const RECIPE_ACTION_ID = 'resolveConflicts'
const RECIPE_ARGS = '--recipe remote-conflicts'

test.use({
  seededCustomAgents: { agents: [CUSTOM_AGENT] },
  seededSourceControlActions: { [RECIPE_ACTION_ID]: { agentArgs: RECIPE_ARGS } }
})

test.describe('SSH custom-agent surfaces', () => {
  test.skip(!RUN_DOCKER_SSH, 'Set ORCA_E2E_SSH_DOCKER=1 to run Docker-backed SSH custom-agent e2e.')
  test.skip(process.platform === 'win32', 'Docker SSH custom-agent e2e uses POSIX ssh tooling.')

  test('resolves a new-workspace-composer launch on the SSH remote', async ({
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

      await launchCustomAgentViaBoundary(orcaPage, {
        worktreeId: remote.worktreeId,
        agentId: CUSTOM_AGENT_ID,
        launchSource: 'new_workspace_composer'
      })

      await ensureTerminalVisible(orcaPage, 45_000)
      await waitForActiveTerminalManager(orcaPage, 60_000)
      const ptyId = await waitForActivePanePtyId(orcaPage, 60_000)
      await waitForTerminalOutput(orcaPage, READY_MARKER, 60_000, 80_000)

      // Exactly one remote node agent, launched with the container fixture path.
      await expect
        .poll(() => observeRemoteAgentProcesses(target!).length, {
          timeout: 30_000,
          message: 'remote composer-launched custom agent did not appear'
        })
        .toBe(1)
      const [remoteProcess] = observeRemoteAgentProcesses(target)
      expect(remoteProcess.argv).toContain(REMOTE_CUSTOM_AGENT_FIXTURE_PATH)

      await sendToTerminal(orcaPage, ptyId, '\x03')
    } finally {
      cleanupDockerSshRelayTarget(target)
    }
  })

  test('threads a git-action recipe’s agentArgs into the SSH remote launch argv', async ({
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

      await launchCustomAgentViaBoundary(orcaPage, {
        worktreeId: remote.worktreeId,
        agentId: CUSTOM_AGENT_ID,
        launchSource: 'conflict_resolution',
        sourceRecord: { owner: 'source-control-recipe', id: RECIPE_ACTION_ID }
      })

      await ensureTerminalVisible(orcaPage, 45_000)
      await waitForActiveTerminalManager(orcaPage, 60_000)
      const ptyId = await waitForActivePanePtyId(orcaPage, 60_000)
      await waitForTerminalOutput(orcaPage, READY_MARKER, 60_000, 80_000)

      // The recipe's stored agentArgs reached THIS remote process's argv: the
      // fixture echoes everything past `node <fixture>`, which is the host-resolved
      // perLaunchArgs band.
      await waitForTerminalOutput(orcaPage, `${ARGV_PREFIX}${RECIPE_ARGS}`, 60_000, 80_000)

      // Corroborate against the real remote /proc cmdline: the recipe arg tokens
      // are present in the launched argv, not just the terminal echo.
      await expect
        .poll(() => observeRemoteAgentProcesses(target!).length, {
          timeout: 30_000,
          message: 'remote git-action custom agent did not appear'
        })
        .toBe(1)
      const [remoteProcess] = observeRemoteAgentProcesses(target)
      for (const token of RECIPE_ARGS.split(' ')) {
        expect(remoteProcess.argv).toContain(token)
      }

      testInfo.annotations.push({
        type: 'ssh-custom-agent-git-action',
        description: `remote argv=${remoteProcess.argv.join(' ')}`
      })

      await sendToTerminal(orcaPage, ptyId, '\x03')
    } finally {
      cleanupDockerSshRelayTarget(target)
    }
  })
})
