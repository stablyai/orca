import type { ComposerModel } from './composer-model'

export function composerSetupCardProps(state: ComposerModel) {
  return {
    setupConfig: state.isProjectGroupTarget ? state.groupSetup.setupConfig : state.setupConfig,
    requiresExplicitSetupChoice: state.isProjectGroupTarget
      ? state.groupSetup.requiresExplicitSetupChoice
      : state.requiresExplicitSetupChoice,
    setupDecision: state.isProjectGroupTarget ? state.groupSetup.decision : state.setupDecision,
    onSetupDecisionChange: state.isProjectGroupTarget
      ? state.groupSetup.setDecision
      : state.setSetupDecision,
    setupAgentStartupPolicy: state.isProjectGroupTarget
      ? state.groupSetup.startupPolicy
      : state.setupAgentStartupPolicy,
    onSetupAgentStartupPolicyChange: state.isProjectGroupTarget
      ? state.groupSetup.setStartupPolicy
      : state.handleSetupAgentStartupPolicyChange,
    shouldWaitForSetupCheck: state.isProjectGroupTarget
      ? state.groupSetup.shouldWaitForSetupCheck
      : state.shouldWaitForSetupCheck,
    resolvedSetupDecision: state.isProjectGroupTarget
      ? state.groupSetup.resolvedSetupDecision
      : state.resolvedSetupDecision
  }
}
