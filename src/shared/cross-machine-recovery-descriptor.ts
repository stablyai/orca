import type { AgentStatusState } from './agent-status-types'
import type { ResumableTuiAgent } from './agent-session-resume'
import type {
  RecoveryBindingKey,
  RecoveryBindingSelector,
  RecoveryOmittedBinding
} from './cross-machine-recovery-binding-key'
import type { GitHubRepositoryIdentity } from './github/pull-request-types'
import type { RepoKind } from './repo-types'
import type { Tab, TabGroup, TabGroupLayoutNode, WorkspaceVisibleTabType } from './tab-types'
import type { TerminalPaneLayoutNode, TerminalTab } from './terminal-tab-types'
import type { WorktreeMeta } from './worktree/meta-types'

export const CROSS_MACHINE_RECOVERY_DESCRIPTOR_VERSION = 1
export const CROSS_MACHINE_RECOVERY_DESCRIBE_PROTOCOL = 1
export const MAX_RECOVERY_DESCRIPTOR_BYTES = 4 * 1024 * 1024

export const CROSS_MACHINE_RECOVERY_ERROR_CODES = [
  'recovery_local_only',
  'recovery_unsupported',
  'recovery_repo_unregistered',
  'recovery_checkout_missing',
  'recovery_destination_not_empty',
  'recovery_descriptor_invalid',
  'recovery_descriptor_too_large',
  'recovery_session_live_locally',
  'recovery_binding_not_found',
  'recovery_binding_ambiguous'
] as const

export type CrossMachineRecoveryErrorCode = (typeof CROSS_MACHINE_RECOVERY_ERROR_CODES)[number]

export type RecoveryTab = Omit<Tab, 'worktreeId' | 'executionHostId'>

export type RecoveryTabGroup = Omit<TabGroup, 'worktreeId'>

export type RecoveryTerminalTab = Omit<
  TerminalTab,
  | 'worktreeId'
  | 'ptyId'
  | 'generation'
  | 'pendingActivationSpawn'
  | 'recovery'
  | 'forceHostRuntime'
  | 'shellOverride'
>

export type RecoveryTerminalLayout = {
  root: TerminalPaneLayoutNode | null
  activeLeafId: string | null
  expandedLeafId: string | null
  chatLeafId?: string
  titlesByLeafId?: Record<string, string>
}

export type RecoveryEditor = {
  relativePath: string
  language: string
  isPreview?: boolean
  readOnly?: boolean
}

export type RecoveryBrowserPage = { id: string; url: string; title?: string }

export type RecoveryBrowser = {
  id: string
  label?: string
  activePageId: string | null
  pages: RecoveryBrowserPage[]
}

/** Host-authoritative projection of one workspace's local-partition layout. */
export type RecoveryLayout = {
  tabs: RecoveryTab[]
  groups: RecoveryTabGroup[]
  groupLayout: TabGroupLayoutNode | null
  activeGroupId: string | null
  terminalTabs: RecoveryTerminalTab[]
  terminalLayouts: Record<string, RecoveryTerminalLayout>
  startupCwdRelative: Record<string, string>
  editors: RecoveryEditor[]
  activeEditorRelativePath: string | null
  browsers: RecoveryBrowser[]
  activeBrowserId: string | null
  activeTabType: WorkspaceVisibleTabType | null
  activeTabId: string | null
}

export type RecoveryProviderSession = {
  key: 'session_id' | 'conversation_id'
  id: string
  transcriptPath?: string
}

export type RecoveryLaunchPreferences = { model?: string; effort?: string; mode?: string }

export type RecoveryAgentBinding = {
  sourcePaneKey: string
  sourceTabId: string
  sourceLeafId: string | null
  surface: 'terminal' | 'structured'
  agent: ResumableTuiAgent
  providerSession: RecoveryProviderSession
  structuredCursor?: { provider: 'claude'; sessionId: string; leafUuid: string | null }
  liveness: 'live' | 'sleeping' | 'exited'
  state: AgentStatusState
  launch: {
    launchPreferences?: RecoveryLaunchPreferences
    sourceAgentArgs: string | null
    /** Env key names only, kept for provenance; values never leave the source host. */
    sourceEnvKeys: string[]
    accountHomeVariable?: 'CLAUDE_CONFIG_DIR' | 'CODEX_HOME'
  }
  terminalTitle?: string
  prompt?: string
  lastAssistantMessage?: string
  capturedAt: number
  updatedAt: number
  lastHumanInputAt: number | null
}

export type RecoveryPresentationFocus = {
  isActiveWorkspace: boolean
  focusedTabId: string | null
  focusedLeafId: string | null
  focusedPaneKey: string | null
  windowFocused: boolean
}

export type RecoveryPresentationClientKind = 'local-renderer' | 'paired-device'

// Why 'host-bindings-only': SSH workspaces publish no client views, so their export carries only
// host bindings; cc-sync reports that as layout 'none'.
export type RecoveryPresentationFreshness = 'client-view' | 'host-only' | 'host-bindings-only'

export type RecoveryPresentationViewExport = {
  clientKey: string
  clientInstanceId: string
  clientName: string
  clientKind: RecoveryPresentationClientKind
  hostReceivedAt: number
  lastHumanInputAt: number | null
  lastHumanFocusAt: number | null
  focus: RecoveryPresentationFocus
  view: RecoveryLayout
}

export type RecoveryPresentationExport = {
  views: RecoveryPresentationViewExport[]
  preferredClientKey: string | null
  freshness: RecoveryPresentationFreshness
}

export type RecoveryWorkspaceMeta = Pick<
  WorktreeMeta,
  | 'displayName'
  | 'comment'
  | 'linkedIssue'
  | 'linkedPR'
  | 'linkedLinearIssue'
  | 'linkedWorkItem'
  | 'baseRef'
  | 'createdWithAgent'
  | 'lastActivityAt'
  | 'isPinned'
>

export type OrcaRecoveryDescriptorV1 = {
  version: typeof CROSS_MACHINE_RECOVERY_DESCRIPTOR_VERSION
  exportedAt: number
  source: {
    runtimeId: string
    appVersion: string
    machineName: string
    platform: NodeJS.Platform
    executionHostId: 'local'
  }
  repo: {
    id: string
    path: string
    displayName: string
    kind?: RepoKind
    upstream?: GitHubRepositoryIdentity | null
    worktreeBaseRef?: string
  }
  workspace: {
    worktreeId: string
    instanceId: string
    path: string
    branch: string | null
    meta: RecoveryWorkspaceMeta
  }
  layout: RecoveryLayout
  presentation: RecoveryPresentationExport
  /** Live, dormant and structured sessions, one per recoveryBindingKeyString with live winning.
   *  v1 exports only the agents in RECOVERY_V1_EXPORT_AGENTS; the rest are listed in omittedBindings. */
  bindings: RecoveryAgentBinding[]
  omittedBindings: RecoveryOmittedBinding[]
}

export type RecoveryPresentationSource =
  | { kind: 'client-view'; clientKey: string }
  | { kind: 'host-layout' }

export type RecoveryPathMapping = { from: string; to: string }

/** A provider session the recovery provider re-keyed (forked) before import: source id → local id. */
export type RecoverySessionIdMapping = { from: string; to: string }

export type RecoveryProvenance = {
  importKey: string
  checkpointId: string
  importedAt: number
  source: {
    runtimeId: string
    machineName: string
    platform: NodeJS.Platform
    appVersion: string
    worktreeId: string
    instanceId: string
    path: string
    exportedAt: number
  }
  presentationSource: RecoveryPresentationSource
  /** Canonical binding keys already launched or released here; a replay never re-adds them. */
  consumedBindings?: string[]
}

export type RecoveryImportRequest = {
  descriptor: OrcaRecoveryDescriptorV1
  /** Must already exist; reposync restores it before import. */
  checkoutPath: string
  checkpointId: string
  pathMap?: RecoveryPathMapping[]
  /** Rewrites binding ids, transcript basenames and structured cursors; resume[] names local ids. */
  sessionIdMap?: RecoverySessionIdMapping[]
  /** Bindings to resume after import; the rest import dormant. A bare provider session id must
   *  name exactly one descriptor binding, else the import fails with recovery_binding_ambiguous. */
  resume?: RecoveryBindingSelector[]
  preferClientInstanceId?: string
  activate?: boolean
  registerRepo?: boolean
  dryRun?: boolean
}

export type RecoveryImportIdMap = {
  tabs: Record<string, string>
  groups: Record<string, string>
  leaves: Record<string, string>
  browsers: Record<string, string>
}

export type RecoveryImportBindingResult = {
  sourcePaneKey: string
  localPaneKey: string
  /** Local identity, after sessionIdMap and pathMap. */
  binding: RecoveryBindingKey
  sourceProviderSessionId: string
  status: 'dormant' | 'resumed' | 'refused'
  reason?: string
  terminalHandle?: string
}

export type RecoveryImportResult = {
  importKey: string
  disposition: 'imported' | 'replayed'
  repoId: string
  worktreeId: string
  instanceId: string
  presentationSource: RecoveryPresentationSource
  idMap: RecoveryImportIdMap
  bindings: RecoveryImportBindingResult[]
  provenance: RecoveryProvenance
}

export type RecoveryDescribeResult = {
  protocol: typeof CROSS_MACHINE_RECOVERY_DESCRIBE_PROTOCOL
  runtimeId: string
  executionHostId: 'local'
  appVersion: string
  platform: NodeJS.Platform
  machineName: string
  hostKind: 'desktop' | 'headless'
  localClientInstanceId: string | null
  capabilities: string[]
}

export type RecoveryExportResult = { descriptor: OrcaRecoveryDescriptorV1 }

export type RecoveryResumeResult = {
  terminalHandle: string
  disposition: 'created' | 'adopted'
  localPaneKey: string
}

export type RecoveryListedBinding = {
  worktreeId: string
  localPaneKey: string
  importKey: string
  sourcePaneKey: string
  agent: ResumableTuiAgent
  providerSession: RecoveryProviderSession
  terminalTitle?: string
  capturedAt: number
  updatedAt: number
  provenance: RecoveryProvenance | null
}

export type RecoveryListResult = { bindings: RecoveryListedBinding[] }
