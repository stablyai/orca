import type { AgentStatusEntry } from '../contracts/agent-status-types'

type MetadataField =
  | 'observation'
  | 'mirroredEvidenceReceivedAt'
  | 'updatedAt'
  | 'evidenceObservedAt'
  | 'acceptedStatusSeq'
  | 'toolName'
  | 'toolInput'
  | 'lastAssistantMessage'
  | 'lastAssistantMessageIsToolOutput'

const membershipComparisons: Record<
  Exclude<keyof AgentStatusEntry, MetadataField>,
  (before: AgentStatusEntry, after: AgentStatusEntry) => boolean
> = {
  executionHost: (before, after) => before.executionHost === after.executionHost,
  paneSleep: (before, after) => before.paneSleep === after.paneSleep,
  subagentObservation: (before, after) => before.subagentObservation === after.subagentObservation,
  state: (before, after) => before.state === after.state,
  workingMode: (before, after) => before.workingMode === after.workingMode,
  prompt: (before, after) => before.prompt === after.prompt,
  structuredHostOwned: (before, after) => before.structuredHostOwned === after.structuredHostOwned,
  stateStartedAt: (before, after) => before.stateStartedAt === after.stateStartedAt,
  stateObservedAt: (before, after) => before.stateObservedAt === after.stateObservedAt,
  turnStartedAt: (before, after) => before.turnStartedAt === after.turnStartedAt,
  turnEndedAt: (before, after) => before.turnEndedAt === after.turnEndedAt,
  turnEndDisposition: (before, after) => before.turnEndDisposition === after.turnEndDisposition,
  agentType: (before, after) => before.agentType === after.agentType,
  model: (before, after) => before.model === after.model,
  modelSwitchCommand: (before, after) => before.modelSwitchCommand === after.modelSwitchCommand,
  paneKey: (before, after) => before.paneKey === after.paneKey,
  terminalHandle: (before, after) => before.terminalHandle === after.terminalHandle,
  worktreeId: (before, after) => before.worktreeId === after.worktreeId,
  connectionId: (before, after) => before.connectionId === after.connectionId,
  tabId: (before, after) => before.tabId === after.tabId,
  terminalTitle: (before, after) => before.terminalTitle === after.terminalTitle,
  stateHistory: (before, after) => before.stateHistory === after.stateHistory,
  firstStateStartedAt: (before, after) => before.firstStateStartedAt === after.firstStateStartedAt,
  interactivePrompt: (before, after) => before.interactivePrompt === after.interactivePrompt,
  lastCompletedAssistantMessage: (before, after) =>
    before.lastCompletedAssistantMessage === after.lastCompletedAssistantMessage,
  interrupted: (before, after) => before.interrupted === after.interrupted,
  sessionBoundary: (before, after) => before.sessionBoundary === after.sessionBoundary,
  orchestration: (before, after) => before.orchestration === after.orchestration,
  subagents: (before, after) => before.subagents === after.subagents,
  mainAgent: (before, after) => before.mainAgent === after.mainAgent,
  children: (before, after) => before.children === after.children,
  providerSession: (before, after) => before.providerSession === after.providerSession,
  orcaSessionId: (before, after) => before.orcaSessionId === after.orcaSessionId,
  launchAttested: (before, after) => before.launchAttested === after.launchAttested,
  terminalResumeEligible: (before, after) =>
    before.terminalResumeEligible === after.terminalResumeEligible,
  promptInteractionKey: (before, after) =>
    before.promptInteractionKey === after.promptInteractionKey,
  programStatus: (before, after) => before.programStatus === after.programStatus,
  restoredUnconfirmed: (before, after) => before.restoredUnconfirmed === after.restoredUnconfirmed
}
const comparisons = Object.values(membershipComparisons)

export function agentRowMembershipFieldsEqual(
  before: AgentStatusEntry,
  after: AgentStatusEntry
): boolean {
  for (let index = 0; index < comparisons.length; index++) {
    if (!comparisons[index]!(before, after)) {
      return false
    }
  }
  return (
    before.observation?.origin === after.observation?.origin &&
    before.observation?.authorityId === after.observation?.authorityId &&
    before.observation?.incarnation === after.observation?.incarnation &&
    before.observation?.boundary === after.observation?.boundary &&
    before.observation?.kind === after.observation?.kind
  )
}

export function agentRowMembershipChanged(
  changes: readonly {
    previous: AgentStatusEntry | undefined
    current: AgentStatusEntry | undefined
  }[]
): boolean {
  for (const { previous, current } of changes) {
    if (!previous || !current || !agentRowMembershipFieldsEqual(previous, current)) {
      return true
    }
  }
  return false
}
