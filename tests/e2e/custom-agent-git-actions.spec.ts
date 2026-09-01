import type { CustomTuiAgentId } from '../../src/shared/types'
import { test } from './helpers/orca-app'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  sendToTerminal,
  waitForActivePanePtyId,
  waitForActiveTerminalManager,
  waitForTerminalOutput
} from './helpers/terminal'
import {
  ARGV_PREFIX,
  buildCustomAgent,
  expectCustomAgentSeeded,
  launchCustomAgentViaBoundary,
  READY_MARKER
} from './helpers/custom-agent-e2e'

// Source-control git actions (resolve conflicts, fix checks, commit/push
// recovery) launch a custom agent by naming its identity AND the source-control
// recipe via sourceRecord { owner: 'source-control-recipe', id: <actionId> }.
// The client sends only the owner locator; the host resolves the recipe's stored
// agentArgs into host-owned perLaunchArgs and appends them to the launched argv.
// These specs prove that host-owned recipe→perLaunchArgs→argv path lands through
// the real boundary for multiple action ids and their real launch_sources.
//
// Not covered here (deliberately): the recovery auto-select guard — a recipe
// whose agentId is a custom id is dropped by readSourceControlLaunchRecipeAgentId
// so recovery falls back to a base agent. That is a pure renderer function
// covered by unit tests; custom-agent git launches always select the custom via
// selection.agent (the dialog path), which is exactly what these specs drive.
const CUSTOM_AGENT = buildCustomAgent({
  uuid: '5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7081',
  label: 'E2E Git Action Agent'
})
const CUSTOM_AGENT_ID = CUSTOM_AGENT.id as CustomTuiAgentId

// Real source-control launch-action ids seeded with distinct stored agentArgs.
const CONFLICT_ACTION_ID = 'resolveConflicts'
const CONFLICT_ARGS = '--recipe conflicts'
const PUSH_RECOVERY_ACTION_ID = 'fixPushFailure'
const PUSH_RECOVERY_ARGS = '--recipe push-recovery'

test.use({
  seededCustomAgents: { agents: [CUSTOM_AGENT] },
  seededSourceControlActions: {
    [CONFLICT_ACTION_ID]: { agentArgs: CONFLICT_ARGS },
    [PUSH_RECOVERY_ACTION_ID]: { agentArgs: PUSH_RECOVERY_ARGS }
  }
})

async function launchGitActionAndAssertArgv(
  orcaPage: Parameters<typeof waitForSessionReady>[0],
  options: {
    actionId: string
    expectedArgs: string
    launchSource: Parameters<typeof launchCustomAgentViaBoundary>[1]['launchSource']
  }
): Promise<void> {
  await waitForSessionReady(orcaPage)
  const worktreeId = await waitForActiveWorktree(orcaPage)
  await expectCustomAgentSeeded(orcaPage, CUSTOM_AGENT_ID, CUSTOM_AGENT.label)

  await launchCustomAgentViaBoundary(orcaPage, {
    worktreeId,
    agentId: CUSTOM_AGENT_ID,
    launchSource: options.launchSource,
    sourceRecord: { owner: 'source-control-recipe', id: options.actionId }
  })

  await ensureTerminalVisible(orcaPage)
  await waitForActiveTerminalManager(orcaPage, 30_000)
  const ptyId = await waitForActivePanePtyId(orcaPage, 30_000)
  await waitForTerminalOutput(orcaPage, READY_MARKER, 30_000)

  // The recipe's stored agentArgs reached THIS spawned process's argv — proving
  // the host-owned recipe→perLaunchArgs→argv path lands through the real boundary.
  await waitForTerminalOutput(orcaPage, `${ARGV_PREFIX}${options.expectedArgs}`, 30_000)

  // Clean shutdown so the daemon/PTY teardown does not race the app close.
  await sendToTerminal(orcaPage, ptyId, '\x03')
}

test('threads a conflict-resolution recipe’s agentArgs into the launched custom agent argv', async ({
  orcaPage
}) => {
  await launchGitActionAndAssertArgv(orcaPage, {
    actionId: CONFLICT_ACTION_ID,
    expectedArgs: CONFLICT_ARGS,
    launchSource: 'conflict_resolution'
  })
})

test('threads a push-recovery recipe’s agentArgs into the launched custom agent argv', async ({
  orcaPage
}) => {
  await launchGitActionAndAssertArgv(orcaPage, {
    actionId: PUSH_RECOVERY_ACTION_ID,
    expectedArgs: PUSH_RECOVERY_ARGS,
    launchSource: 'source_control_recovery'
  })
})
