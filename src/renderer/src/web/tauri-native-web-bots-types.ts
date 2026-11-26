export type AuthState = 'unknown' | 'authenticated' | 'logged_out'

export type AccountKey = {
  providerId: string
  uuid: string
}

export type ProviderInfo = {
  id: string
  name: string
  shortName: string
  enabled: boolean
  entryUrl: string
  homepageUrl: string
  isCustom: boolean
  allowedHosts: string[]
}

export type CustomWebProviderRecord = {
  id: string
  name: string
  shortName: string
  entryUrl: string
  allowedHosts: string[]
  createdAtMs: number
}

export type QuotaDetail = {
  planLabel: string
  planValue: string
  planSubtext: string | null
  planUsedPercent: number | null
  extraLabel: string | null
  extraValue: string | null
  extraSubtext: string | null
  extraUsedPercent: number | null
}

export type AccountRecord = {
  providerId: string
  uuid: string
  alias: string
  autoAlias: boolean
  email: string | null
  createdAtMs: number
  proxyUrl: string | null
  timezone: string | null
  avatarUrl: string | null
  quotaText: string | null
  quotaPercent: number | null
  quotaDetail: QuotaDetail | null
  authState: AuthState
  cookieExpiresAtMs: number | null
  cookieSessionOnly: boolean
  cooldownUntilMs: number | null
  lastUsedAtMs: number | null
}

export type ExternalAgentKind = 'openai_api' | 'local_cli'

export type ExternalAgentRecord = {
  id: string
  kind: ExternalAgentKind
  name: string
  baseUrl: string
  apiKey: string
  model: string
  command: string
  args: string[]
  workdir: string | null
  createdAtMs: number
}

export type GroupWorkflowMode = 'parallel' | 'review' | 'a2a_relay'

export type GroupReplyStatus = 'queued' | 'sending' | 'streaming' | 'done' | 'needs_auth' | 'error'

export type GroupSharedSkill = {
  id: string
  name: string
  description: string
  content: string
  enabled: boolean
}

export type GroupMemberRole = {
  member: AccountKey
  role: string
}

export type GroupThreadBinding = {
  member: AccountKey
  threadUrl: string
  updatedAtMs: number
}

export type GroupChatMessage = {
  id: string
  role: string
  sender: AccountKey | null
  senderName: string
  content: string
  createdAtMs: number
  status: GroupReplyStatus
  targets: AccountKey[]
  error: string | null
  stageLabel: string | null
  hopDepth: number | null
  autoRoutedChannel: string | null
}

export type GroupChatRecord = {
  id: string
  name: string
  members: AccountKey[]
  createdAtMs: number
  messages: GroupChatMessage[]
  sharedContext: string
  sharedSkills: GroupSharedSkill[]
  memberRoles: GroupMemberRole[]
  workflowMode: GroupWorkflowMode
  maxRelayHops: number
  threadBindings: GroupThreadBinding[]
}

export type WebBotsSettings = {
  isolateSameProxyKeepAlive: boolean
  silentSyncIntervalMins: number
}

export type AccountPageError = {
  providerId: string
  uuid: string
  message: string
}

export type WebBotsSnapshot = {
  providers: ProviderInfo[]
  customProviders: CustomWebProviderRecord[]
  accounts: AccountRecord[]
  selectedProviderId: string
  activeAccount: AccountKey | null
  warmAccounts: AccountKey[]
  settings: WebBotsSettings
  groupChats: GroupChatRecord[]
  activeGroupId: string | null
  externalAgents: ExternalAgentRecord[]
  accountErrors: AccountPageError[]
}

export type ProxyTestResult = {
  ok: boolean
  latencyMs: number
  statusCode: number | null
  targetHost: string
  usedProxy: boolean
  message: string
}

export type SiteAdapterConfig = {
  id: string
  name: string
  hostPatterns: string[]
  composerSelectors: string[]
  sendButtonSelectors: string[]
  stopButtonSelectors: string[]
  messageListSelectors: string[]
  assistantMessageSelectors: string[]
  newChatSelectors: string[]
  newChatUrl: string | null
  threadUrlPatterns: string[]
  transientStatusWords: string[]
  chatApiPatterns: string[]
  preferEnterSubmit: boolean
  asyncAgent?: boolean
}

export type SiteAdaptersSnapshot = {
  adapters: SiteAdapterConfig[]
  overridePath: string
  hasOverrides: boolean
  overrideJson: string
}

export type WebBotViewportBounds = {
  x: number
  y: number
  width: number
  height: number
  visible: boolean
}

export type ExportSyncBundleResponse = {
  filename: string
  bundleJson: string
  accountCount: number
  cookieAccountCount: number
}

export type SyncImportSummary = {
  addedAccounts: number
  updatedAccounts: number
  importedCookieAccounts: number
  skippedCookieAccounts: number
  mergedGroups: number
  mergedExternalAgents: number
}

export type ImportSyncBundleResponse = {
  snapshot: WebBotsSnapshot
  summary: SyncImportSummary
}
