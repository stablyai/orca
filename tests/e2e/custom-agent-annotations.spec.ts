import type { CustomTuiAgentId } from '../../src/shared/types'
import { test } from './helpers/orca-app'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
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
  READY_MARKER
} from './helpers/custom-agent-e2e'

// Annotation surfaces (diff notes, browser annotations) launch a NEW custom
// agent through QuickLaunchAgentMenuItems → launchAgentInNewTab with
// launch_source 'notes_send' and promptDelivery 'submit-after-ready': the tab
// launches bare (allowEmptyPromptLaunch) and the annotation markdown is pasted
// and submitted once the agent is ready. This spec drives that launch boundary
// and then proves the annotation content reaches THIS process.
//
// Not covered here (deliberately): the "Send notes to <running agent>" followup
// and the terminal-context-menu fork. Both gate on agent-status readiness the
// deterministic echo fixture cannot emit (it is not a real TUI agent), and the
// fork path nulls custom ids in resolveTuiAgent — those are covered by unit
// tests, not this launch-surface suite.
const CUSTOM_AGENT = buildCustomAgent({
  uuid: '4d5e6f7a-8b9c-4d0e-8f1a-2b3c4d5e6f70',
  label: 'E2E Annotation Agent'
})
const CUSTOM_AGENT_ID = CUSTOM_AGENT.id as CustomTuiAgentId

test.use({ seededCustomAgents: { agents: [CUSTOM_AGENT] } })

test('launches a custom agent from an annotation send and delivers the note content', async ({
  orcaPage
}) => {
  await waitForSessionReady(orcaPage)
  const worktreeId = await waitForActiveWorktree(orcaPage)
  await expectCustomAgentSeeded(orcaPage, CUSTOM_AGENT_ID, CUSTOM_AGENT.label)

  // notes_send launches bare (allowEmptyPromptLaunch): the annotation markdown is
  // delivered post-ready, not folded into the launch. Match that shape by
  // launching without a prompt, then delivering the note once the agent is ready.
  await launchCustomAgentViaBoundary(orcaPage, {
    worktreeId,
    agentId: CUSTOM_AGENT_ID,
    launchSource: 'notes_send'
  })

  await ensureTerminalVisible(orcaPage)
  await waitForActiveTerminalManager(orcaPage, 30_000)
  await waitForPaneCount(orcaPage, 1, 30_000)
  const ptyId = await waitForActivePanePtyId(orcaPage, 30_000)
  await waitForTerminalOutput(orcaPage, READY_MARKER, 30_000)

  // The annotation content is delivered post-ready (submit-after-ready). Prove it
  // reaches the launched process: the fixture echoes the submitted line back with
  // a prefix the terminal itself never produces (raw mode, no local echo).
  const ANNOTATION_NOTE = 'review-annotation-payload'
  await sendToTerminal(orcaPage, ptyId, `${ANNOTATION_NOTE}\r`)
  await waitForTerminalOutput(orcaPage, `${ECHO_PREFIX}${ANNOTATION_NOTE}`, 15_000)

  // Clean shutdown so the daemon/PTY teardown does not race the app close.
  await sendToTerminal(orcaPage, ptyId, '\x03')
})
