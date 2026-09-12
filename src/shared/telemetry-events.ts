// Single source of truth for telemetry event names, schemas, and enums.
// Zod-first: `EventMap` is `z.infer`-derived from the same `eventSchemas` record the runtime validator consumes — no parallel union to drift.
// `.strict()` on every object schema is the runtime "no extra keys"; free-form strings carry an explicit `.max(N)` cap.

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
