import {
  onboardingLanguagePickerOpenedSchema,
  onboardingLanguageChangedSchema,
  onboardingLanguageRequestedSchema
} from './telemetry-onboarding-language-schemas'
import { agentTokenUsageSchema } from './telemetry-agent-token-usage-schema'
import {
  agentDashboardActiveSchema,
  agentDashboardEnabledSchema,
  agentDashboardOpenedSchema
} from './telemetry-agent-dashboard-event-schemas'
import {
  agentErrorSchema,
  agentPromptSentSchema,
  agentStartedSchema,
  appOpenedSchema,
  appStarredOrcaSchema,
  featureInteractionUsageBucketReachedSchema,
  repoAddedSchema,
  starNagOutcomeEventSchema,
  workspaceCreatedSchema
} from './telemetry-app-event-schemas'
import {
  agentHookInstallFailedSchema,
  agentHookTransportBlockedSchema,
  agentHookUnattributedSchema,
  codexTrustGrantSchema,
  daemonAdoptedSchema,
  daemonAsyncIoHealthSchema,
  daemonAuditEligibilitySchema,
  daemonFolderAccessNoticeSchema,
  daemonLifecycleSchema,
  daemonPtyCwdVerdictSchema,
  daemonStartFailedSchema,
  mainThreadHangDetectedSchema,
  profileStateAuthoritySelectedSchema,
  remoteOutboundBudgetCloseSchema,
  runtimeRpcStartFailedSchema,
  settingsChangedSchema
} from './telemetry-daemon-event-schemas'
import {
  contextualTourOutcomeSchema,
  contextualTourShownSchema,
  editorExternalChangeConflictActionSchema,
  editorExternalChangeConflictShownSchema,
  setupGuideClosedSchema,
  setupGuideOpenedSchema,
  setupGuideStepCompletedSchema,
  terminalPaneSplitSchema
} from './telemetry-feature-education-event-schemas'
import {
  cmdJPaletteFeatureTipAcknowledgedSchema,
  cmdJPaletteFeatureTipShownSchema,
  featureWallClosedSchema,
  featureWallDocsClickedSchema,
  featureWallFeatureSelectedSchema,
  featureWallGroupSelectedSchema,
  featureWallOpenedSchema,
  featureWallTileClickedSchema,
  featureWallTileFocusedSchema,
  nativeChatMessageSentSchema,
  nativeChatPickerItemAcceptedSchema,
  nativeChatPickerOpenedSchema,
  nativeChatSendClassifiedSchema,
  nativeChatSkillDiscoverySchema,
  nativeChatToggledSchema,
  orcaCliFeatureTipSetupClickedSchema,
  orcaCliFeatureTipSetupResultSchema,
  orcaCliFeatureTipShownSchema,
  telemetryOptedInSchema,
  telemetryOptedOutSchema
} from './telemetry-native-feature-event-schemas'
import {
  activationChecklistItemCompletedSchema,
  onboardingAgentPickedSchema,
  onboardingCompletedSchema,
  onboardingDismissedSchema,
  onboardingFeatureSetupRunSchema,
  onboardingFeatureSetupTerminalInteractedSchema,
  onboardingFeatureSetupTerminalOpenedSchema,
  onboardingFeatureSetupToggledSchema,
  onboardingGhosttyDiscoveredSchema,
  onboardingGhosttyImportClickedSchema,
  onboardingGhosttyImportFailedSchema,
  onboardingStartedSchema,
  onboardingStep4PathClickedSchema,
  onboardingStep4PathFailedSchema,
  onboardingStepCompletedSchema,
  onboardingStepSkippedSchema,
  onboardingStepViewedSchema,
  onboardingTaskSourcesSnapshotSchema,
  onboardingTourOutcomeEventSchema,
  onboardingWindowsTerminalSnapshotSchema
} from './telemetry-onboarding-event-schemas'
import {
  addRepoDefaultCheckoutHandoffSchema,
  addRepoExistingWorkspacesDetectedSchema,
  addRepoNestedImportActionSchema,
  addRepoNestedImportResultSchema,
  addRepoNestedScanResultSchema,
  addRepoSetupStepActionEventSchema,
  setupScriptPromptActionSchema,
  setupScriptPromptShownSchema,
  workspaceCreateFailedSchema
} from './telemetry-repository-event-schemas'
import { pluginInstalledSchema } from './telemetry-plugin-event-schemas'
import { sshRemoteRuntimeResolvedSchema } from './telemetry-ssh-runtime-event-schemas'
import { wslUsageSnapshotSchema } from './telemetry-wsl-usage-event-schemas'
import {
  sshHostServerConversionSchema,
  sshHostServerDecidedSchema,
  sshHostServerDeployFailedSchema,
  sshHostServerMoveSchema,
  sshHostServerLegacyRelayBridgeSchema
} from './telemetry-ssh-host-server-event-schemas'
import {
  wslMoveOrchestratorSchema,
  wslMoveUndoSchema,
  wslMoveSchema
} from './telemetry-wsl-move-event-schemas'

// Breaking payload changes require a new event name to keep historical rows distinguishable; optional additions are safe.
export const eventSchemas = {
  agent_dashboard_active: agentDashboardActiveSchema,
  agent_dashboard_enabled: agentDashboardEnabledSchema,
  agent_dashboard_opened: agentDashboardOpenedSchema,
  app_opened: appOpenedSchema,
  app_starred_orca: appStarredOrcaSchema,
  star_nag_outcome: starNagOutcomeEventSchema,
  feature_interaction_usage_bucket_reached: featureInteractionUsageBucketReachedSchema,

  repo_added: repoAddedSchema,
  add_repo_setup_step_action: addRepoSetupStepActionEventSchema,
  add_repo_existing_workspaces_detected: addRepoExistingWorkspacesDetectedSchema,
  add_repo_default_checkout_handoff: addRepoDefaultCheckoutHandoffSchema,
  add_repo_nested_scan_result: addRepoNestedScanResultSchema,
  add_repo_nested_import_action: addRepoNestedImportActionSchema,
  add_repo_nested_import_result: addRepoNestedImportResultSchema,
  workspace_created: workspaceCreatedSchema,
  workspace_create_failed: workspaceCreateFailedSchema,
  setup_script_prompt_shown: setupScriptPromptShownSchema,
  setup_script_prompt_action: setupScriptPromptActionSchema,

  agent_token_usage: agentTokenUsageSchema,
  agent_started: agentStartedSchema,
  agent_prompt_sent: agentPromptSentSchema,
  agent_error: agentErrorSchema,
  agent_hook_install_failed: agentHookInstallFailedSchema,
  agent_hook_unattributed: agentHookUnattributedSchema,
  agent_hook_transport_blocked: agentHookTransportBlockedSchema,

  daemon_start_failed: daemonStartFailedSchema,
  main_thread_hang_detected: mainThreadHangDetectedSchema,
  daemon_lifecycle: daemonLifecycleSchema,
  daemon_adopted: daemonAdoptedSchema,
  daemon_async_io_health: daemonAsyncIoHealthSchema,
  daemon_pty_cwd_denied: daemonPtyCwdVerdictSchema,
  daemon_pty_cwd_readable: daemonPtyCwdVerdictSchema,
  daemon_folder_access_notice: daemonFolderAccessNoticeSchema,
  daemon_audit_eligibility: daemonAuditEligibilitySchema,
  runtime_rpc_start_failed: runtimeRpcStartFailedSchema,
  remote_outbound_budget_close: remoteOutboundBudgetCloseSchema,
  profile_state_authority_selected: profileStateAuthoritySelectedSchema,

  codex_trust_grant: codexTrustGrantSchema,

  settings_changed: settingsChangedSchema,

  native_chat_toggled: nativeChatToggledSchema,
  native_chat_message_sent: nativeChatMessageSentSchema,
  native_chat_picker_opened: nativeChatPickerOpenedSchema,
  native_chat_picker_item_accepted: nativeChatPickerItemAcceptedSchema,
  native_chat_send_classified: nativeChatSendClassifiedSchema,
  native_chat_skill_discovery: nativeChatSkillDiscoverySchema,

  telemetry_opted_in: telemetryOptedInSchema,
  telemetry_opted_out: telemetryOptedOutSchema,

  orca_cli_feature_tip_shown: orcaCliFeatureTipShownSchema,
  orca_cli_feature_tip_setup_clicked: orcaCliFeatureTipSetupClickedSchema,
  orca_cli_feature_tip_setup_result: orcaCliFeatureTipSetupResultSchema,
  cmd_j_palette_feature_tip_shown: cmdJPaletteFeatureTipShownSchema,
  cmd_j_palette_feature_tip_acknowledged: cmdJPaletteFeatureTipAcknowledgedSchema,

  feature_wall_opened: featureWallOpenedSchema,
  feature_wall_closed: featureWallClosedSchema,
  feature_wall_tile_focused: featureWallTileFocusedSchema,
  feature_wall_tile_clicked: featureWallTileClickedSchema,
  feature_wall_group_selected: featureWallGroupSelectedSchema,
  feature_wall_feature_selected: featureWallFeatureSelectedSchema,
  feature_wall_docs_clicked: featureWallDocsClickedSchema,

  onboarding_language_picker_opened: onboardingLanguagePickerOpenedSchema,
  onboarding_language_changed: onboardingLanguageChangedSchema,
  onboarding_language_requested: onboardingLanguageRequestedSchema,
  onboarding_started: onboardingStartedSchema,
  onboarding_step_viewed: onboardingStepViewedSchema,
  onboarding_step_completed: onboardingStepCompletedSchema,
  onboarding_step_skipped: onboardingStepSkippedSchema,
  onboarding_tour_outcome: onboardingTourOutcomeEventSchema,
  onboarding_step4_path_clicked: onboardingStep4PathClickedSchema,
  onboarding_step4_path_failed: onboardingStep4PathFailedSchema,
  onboarding_task_sources_snapshot: onboardingTaskSourcesSnapshotSchema,
  onboarding_windows_terminal_snapshot: onboardingWindowsTerminalSnapshotSchema,
  onboarding_completed: onboardingCompletedSchema,
  onboarding_dismissed: onboardingDismissedSchema,
  onboarding_agent_picked: onboardingAgentPickedSchema,
  onboarding_ghostty_discovered: onboardingGhosttyDiscoveredSchema,
  onboarding_ghostty_import_clicked: onboardingGhosttyImportClickedSchema,
  onboarding_ghostty_import_failed: onboardingGhosttyImportFailedSchema,
  onboarding_feature_setup_toggled: onboardingFeatureSetupToggledSchema,
  onboarding_feature_setup_run: onboardingFeatureSetupRunSchema,
  onboarding_feature_setup_terminal_opened: onboardingFeatureSetupTerminalOpenedSchema,
  onboarding_feature_setup_terminal_interacted: onboardingFeatureSetupTerminalInteractedSchema,
  activation_checklist_item_completed: activationChecklistItemCompletedSchema,

  contextual_tour_shown: contextualTourShownSchema,
  contextual_tour_outcome: contextualTourOutcomeSchema,
  setup_guide_opened: setupGuideOpenedSchema,
  setup_guide_closed: setupGuideClosedSchema,
  setup_guide_step_completed: setupGuideStepCompletedSchema,
  terminal_pane_split: terminalPaneSplitSchema,

  editor_external_change_conflict_shown: editorExternalChangeConflictShownSchema,
  editor_external_change_conflict_action: editorExternalChangeConflictActionSchema,

  ssh_remote_runtime_resolved: sshRemoteRuntimeResolvedSchema,
  ssh_host_server_decided: sshHostServerDecidedSchema,
  ssh_host_server_conversion: sshHostServerConversionSchema,
  ssh_host_server_deploy_failed: sshHostServerDeployFailedSchema,
  ssh_host_server_move: sshHostServerMoveSchema,
  ssh_host_server_legacy_relay_bridge: sshHostServerLegacyRelayBridgeSchema,

  wsl_move: wslMoveSchema,
  wsl_move_orchestrator: wslMoveOrchestratorSchema,
  wsl_move_undo: wslMoveUndoSchema,

  wsl_usage_snapshot: wslUsageSnapshotSchema,

  plugin_installed: pluginInstalledSchema
} as const
