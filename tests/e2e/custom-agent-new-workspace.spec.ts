import type { CustomTuiAgentId } from '../../src/shared/types'
import { test, expect } from './helpers/orca-app'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  countVisibleTerminalPanes,
  getTerminalContent,
  sendToTerminal,
  waitForActivePanePtyId,
  waitForActiveTerminalManager,
  waitForPaneCount,
  waitForTerminalOutput
} from './helpers/terminal'
import {
  buildCustomAgent,
  ECHO_PREFIX,
  expectCustomAgentSeeded,
  launchCustomAgentViaBoundary,
  READY_MARKER,
  readTabLaunchIdentity
} from './helpers/custom-agent-e2e'

// The Cmd+N new-workspace composer (folder-workspace and git-worktree paths)
// launches a custom agent by naming it via agentLaunch.selection with
// launch_source 'new_workspace_composer'; the host resolves command/args/env.
// These specs drive that exact launch-boundary contract with the composer's
// launch_source (the driving decision: store-boundary for launch surfaces).
const CUSTOM_AGENT = buildCustomAgent({
  uuid: '3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f',
  label: 'E2E Composer Agent'
})
const CUSTOM_AGENT_ID = CUSTOM_AGENT.id as CustomTuiAgentId
const COMPOSER_SOURCE = 'new_workspace_composer' as const

test.use({ seededCustomAgents: { agents: [CUSTOM_AGENT] } })

test('launches a custom agent from the new-workspace composer boundary', async ({ orcaPage }) => {
  await waitForSessionReady(orcaPage)
  const worktreeId = await waitForActiveWorktree(orcaPage)
  await expectCustomAgentSeeded(orcaPage, CUSTOM_AGENT_ID, CUSTOM_AGENT.label)

  const tabId = await launchCustomAgentViaBoundary(orcaPage, {
    worktreeId,
    agentId: CUSTOM_AGENT_ID,
    launchSource: COMPOSER_SOURCE
  })

  await ensureTerminalVisible(orcaPage)
  await waitForActiveTerminalManager(orcaPage, 30_000)
  await waitForPaneCount(orcaPage, 1, 30_000)
  const ptyId = await waitForActivePanePtyId(orcaPage, 30_000)

  // The fixture prints its marker on spawn: the composer's launch_source resolved
  // the seeded custom executable and started it in the pane's PTY.
  await waitForTerminalOutput(orcaPage, READY_MARKER, 30_000)

  // Exactly one pane, and the tab carries the custom agent's identity.
  expect(await countVisibleTerminalPanes(orcaPage)).toBe(1)
  const identity = await readTabLaunchIdentity(orcaPage, worktreeId, tabId)
  expect(identity?.launchAgent).toBe(CUSTOM_AGENT_ID)
  expect(typeof identity?.ptyId).toBe('string')

  // Clean shutdown so the daemon/PTY teardown does not race the app close.
  await sendToTerminal(orcaPage, ptyId, '\x03')
})

test('folds a composer draft prompt into the launched custom agent as unsubmitted input', async ({
  orcaPage
}) => {
  await waitForSessionReady(orcaPage)
  const worktreeId = await waitForActiveWorktree(orcaPage)
  await expectCustomAgentSeeded(orcaPage, CUSTOM_AGENT_ID, CUSTOM_AGENT.label)

  const DRAFT_PROMPT = 'composer-draft-line'
  await launchCustomAgentViaBoundary(orcaPage, {
    worktreeId,
    agentId: CUSTOM_AGENT_ID,
    launchSource: COMPOSER_SOURCE,
    prompt: DRAFT_PROMPT,
    promptDelivery: 'draft'
  })

  await ensureTerminalVisible(orcaPage)
  await waitForActiveTerminalManager(orcaPage, 30_000)
  const ptyId = await waitForActivePanePtyId(orcaPage, 30_000)
  await waitForTerminalOutput(orcaPage, READY_MARKER, 30_000)

  // A 'draft' prompt lands UNSUBMITTED: the fixture only emits its transformed
  // echo line on a submitted (newline-terminated) line, so the raw draft text
  // must NOT yet appear as an echo. Prove the draft did not auto-submit.
  const content = await getTerminalContent(orcaPage)
  expect(content).not.toContain(`${ECHO_PREFIX}${DRAFT_PROMPT}`)

  // Submitting the drafted line drives it into the process, which echoes it back
  // with the prefix the terminal itself never produces (raw mode, no local echo).
  await sendToTerminal(orcaPage, ptyId, '\r')
  await waitForTerminalOutput(orcaPage, `${ECHO_PREFIX}`, 15_000)

  await sendToTerminal(orcaPage, ptyId, '\x03')
})

test('surfaces the same client-safe recovery notice for an unknown composer launch', async ({
  orcaPage
}) => {
  await waitForSessionReady(orcaPage)
  const worktreeId = await waitForActiveWorktree(orcaPage)

  // A well-formed custom id that is deliberately never seeded: the host resolves
  // it against the catalog, finds nothing, and rejects the launch pre-spawn.
  const UNKNOWN_ID = 'custom-agent:codex:9f8e7d6c-5b4a-4938-8271-605f4e3d2c1b' as CustomTuiAgentId
  const isSeeded = await orcaPage.evaluate(async (id) => {
    const snapshot = await window.api.settings.agentCatalog.getLocal()
    return snapshot.customAgents.some(
      (candidate) => candidate.status === 'ready' && candidate.definition.id === id
    )
  }, UNKNOWN_ID)
  expect(isSeeded).toBe(false)

  await launchCustomAgentViaBoundary(orcaPage, {
    worktreeId,
    agentId: UNKNOWN_ID,
    launchSource: COMPOSER_SOURCE
  })

  await ensureTerminalVisible(orcaPage)
  await waitForActiveTerminalManager(orcaPage, 30_000)

  // The pre-spawn failure renders the persistent in-pane recovery notice with
  // localized, client-safe copy — it never leaks the requested agent id.
  await expect(orcaPage.getByText(/no longer exists/i)).toBeVisible({ timeout: 30_000 })
  expect(await orcaPage.getByText('9f8e7d6c').count()).toBe(0)
})
