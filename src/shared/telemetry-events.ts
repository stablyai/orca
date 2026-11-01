// Infer event types from the runtime schema registry to prevent drift; strict objects reject extra keys and strings have explicit caps.

export {
  AGENT_KIND_VALUES,
  SETTINGS_CHANGED_WHITELIST,
  addRepoDefaultCheckoutHandoffReasonSchema,
  addRepoDefaultCheckoutHandoffResultSchema,
  addRepoDefaultCheckoutHandoffSourceSchema,
  addRepoExistingWorkspaceSourceSchema,
  addRepoSetupStepActionSchema,
  agentKindSchema,
  errorClassSchema,
  featureWallExitActionSchema,
  featureWallOpenSourceSchema,
  featureWallTileIdSchema,
  featureWallTourDepthStepSchema,
  featureWallWorkflowIdSchema,
  launchSourceSchema,
  optInViaSchema,
  repoMethodSchema,
  requestKindSchema,
  settingsChangedKeySchema,
  setupScriptImportProviderSchema,
  workspaceCreateErrorClassSchema,
  workspaceSourceSchema
} from './telemetry-property-schemas'
export type {
  AddRepoDefaultCheckoutHandoffSource,
  AddRepoExistingWorkspaceSource,
  AgentKind,
  ErrorClass,
  FeatureWallOpenSourceTelemetry,
  LaunchSource,
  OptInVia,
  RepoMethod,
  RequestKind,
  SettingsChangedKey,
  WorkspaceCreateErrorClass,
  WorkspaceSource
} from './telemetry-property-schemas'

export {
  featureInteractionCategorySchema,
  featureInteractionIdSchema,
  featureInteractionUsageBucketSchema,
  featureInteractionUsageBucketSourceSchema
} from './telemetry-app-event-schemas'
export {
  hookInstallAgentSchema,
  profileStateAuthoritySelectedSchema,
  runtimeRpcStartErrorClassSchema
} from './telemetry-daemon-event-schemas'
export type { HookInstallAgent, RuntimeRpcStartErrorClass } from './telemetry-daemon-event-schemas'
export type { NativeChatRuntime } from './telemetry-native-feature-event-schemas'
export { eventSchemas } from './telemetry-event-registry'
export {
  commonPropsSchema,
  isCohortExtendedEvent,
  isOnboardingEvent
} from './telemetry-event-classification'
export type {
  CommonProps,
  EventMap,
  EventName,
  EventProps,
  OnboardingCohort
} from './telemetry-event-classification'
