import { translate } from '@/i18n/i18n'
import { selectWorktreesByRepo } from '@/store/workspaces/catalog/workspace-record-fields'
import { useAppStore } from '@/store/index'
import { planAgentSessionLaunch } from '@/lib/agent-session/launch/routing/agent-session-launch-plan'
import { agentTabLaunchStore } from '@/lib/agent-session/launch/new-tab/launch-agent-execution-context'
import { activateStructuredAgentSessionById } from '@/lib/agent-session/structured-agent-session-tab-activation'
import { openStructuredAgentSessionProvisionalTab } from '@/lib/agent-session/launch/structured-agent-session-launch-surface'
import { afterPendingTab } from '@/runtime/workspace-layout/intents/layout-owner-pending-tabs'
import { botHostTarget } from '@/lib/bot-hosts'
import { requestNativeChatComposerFocus } from '../native-chat/composer/focus/native-chat-composer-focus-intent'
import { structuredAgentSessionTabId } from '../../../../shared/agent-session/view/structured-agent-session-projection'
import { activateAndRevealWorktree } from '@/lib/workspace/activation/worktree-activation'
import { hydrateNativeChatComposerDrafts } from '../native-chat/drafts/native-chat-composer-draft-load'
import { createNonSecureContextUuid } from '../../../../shared/identifiers/non-secure-context-uuid'
import { workerPreferenceLookup } from '../../../../shared/commander/worker-preference-instructions'
import { handoffPrompt } from '../../../../shared/commander/goal-handoff'
import type {
  CommanderAccount,
  CommanderMemoryRevision
} from '../../../../shared/commander/memory-contract'
import { prepareHandoffDraft } from './open-commander-chat'
import { handoffWorkspaces, type WorkerHandoffDestination } from './handoff-workspaces'

export async function resumeWorkerHandoff(
  account: CommanderAccount,
  page: CommanderMemoryRevision,
  destination: WorkerHandoffDestination,
  isCurrent: () => boolean,
  destinationCurrent: () => boolean = isCurrent
): Promise<boolean> {
  const project = page.projectId
  if (!project || !isCurrent()) {
    return false
  }
  const { hostId, worktreeId, instanceId, agent } = destination
  const checkout = () => {
    const state = useAppStore.getState()
    return handoffWorkspaces(project, hostId, state.repos, selectWorktreesByRepo(state)).find(
      (wt) => wt.id === worktreeId && wt.instanceId === instanceId
    )
  }
  if (!checkout()) {
    return false
  }
  await hydrateNativeChatComposerDrafts()
  if (!isCurrent() || !checkout()) {
    return false
  }
  const store = agentTabLaunchStore(useAppStore.getState(), {
    worktreeId,
    workspaceExecutionHostId: hostId
  })
  const plan = planAgentSessionLaunch(store, {
    requestId: createNonSecureContextUuid(),
    agent,
    requestedSurface: 'chat',
    workspace: { kind: 'git-worktree', worktreeId },
    selectedExecutionHostId: hostId
  })
  const settled = await plan.launch({
    activate: false,
    beforeCreate: () => isCurrent() && !!checkout()
  })
  if (settled?.kind !== 'structured' || !isCurrent() || !checkout()) {
    return false
  }
  // A create receipt may arrive before the host's layout frame. Wait for this session's tab
  // before navigating, so a declined open leaves the handoff visible and its text untouched.
  const tab = openStructuredAgentSessionProvisionalTab({
    worktreeId,
    executionHostId: hostId,
    sessionId: settled.sessionId,
    agent,
    activate: false
  })
  const shown = await new Promise<string | null>((resolve) => afterPendingTab(tab.id, resolve))
  if (!shown || !isCurrent() || !checkout()) {
    return false
  }
  const { guidelines, truncated } = await window.api.commanderMemory.workerGuidance(
    account,
    project
  )
  if (!isCurrent() || !checkout()) {
    return false
  }
  // Fetch only the selected head after the guidance read; the source can change while the tab opens.
  const { page: latest } = await window.api.commanderMemory.get(account, page.pageId, 1)
  const wt = checkout()
  if (!wt || !isCurrent()) {
    return false
  }
  if (
    latest.deleted ||
    latest.version !== page.version ||
    latest.projectId !== project ||
    latest.pageId !== page.pageId
  ) {
    throw new Error(
      translate(
        'commander.handoffs.changed',
        'This handoff changed. Review the latest version before opening chat.'
      )
    )
  }
  const text = [
    handoffPrompt(latest),
    `Destination checkout: ${wt.branch || 'detached HEAD'} at ${wt.head || 'unknown commit'}.`,
    'Check Git status and compare the saved source revision before editing. Uncommitted source files stay on the source host.',
    `${workerPreferenceLookup(project)} If automatic answers are off, the lookup is unavailable, or no single answer matches, ask the owner here. Tool and script approvals follow the host’s permission flow.`,
    ...(guidelines.length
      ? [
          `Account and project guidelines:
${guidelines.join('\n\n')}`
        ]
      : []),
    ...(truncated ? ['Review the remaining guidelines in Commander Memory before acting.'] : [])
  ].join('\n\n')
  const insert = prepareHandoffDraft(settled.sessionId, text, {
    workspaceId: worktreeId,
    executionHostId: hostId
  })
  if (
    activateAndRevealWorktree(worktreeId, {
      executionHostId: hostId,
      providesInitialSurface: true,
      sidebarRevealBehavior: 'auto'
    }) === false ||
    !destinationCurrent() ||
    !checkout()
  ) {
    return false
  }
  if (
    !activateStructuredAgentSessionById({
      worktreeId,
      sessionId: settled.sessionId,
      target: botHostTarget(hostId),
      callerOnly: true
    }) ||
    !destinationCurrent() ||
    !checkout()
  ) {
    return false
  }
  insert()
  requestNativeChatComposerFocus(structuredAgentSessionTabId(settled.sessionId), {
    revealDraft: true
  })
  return true
}
