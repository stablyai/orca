import { invokeNative, listenNative } from './tauri-native-host'
import type {
  AccountKey,
  ExportSyncBundleResponse,
  ExternalAgentKind,
  GroupMemberRole,
  GroupSharedSkill,
  GroupWorkflowMode,
  ImportSyncBundleResponse,
  ProxyTestResult,
  SiteAdaptersSnapshot,
  WebBotViewportBounds,
  WebBotsSettings,
  WebBotsSnapshot
} from './tauri-native-web-bots-types'

export * from './tauri-native-web-bots-types'

export function getWebBotsState(): Promise<WebBotsSnapshot> {
  return invokeNative<WebBotsSnapshot>('poc_web_bots_get_state')
}

export function selectWebBotProvider(providerId: string): Promise<WebBotsSnapshot> {
  return invokeNative<WebBotsSnapshot>('poc_web_bots_select_provider', { providerId })
}

export function addCustomWebBotProvider(input: {
  name: string
  shortName: string | null
  entryUrl: string
  allowedHosts: string[]
}): Promise<WebBotsSnapshot> {
  return invokeNative<WebBotsSnapshot>('poc_web_bots_add_custom_provider', input)
}

export function removeCustomWebBotProvider(providerId: string): Promise<WebBotsSnapshot> {
  return invokeNative<WebBotsSnapshot>('poc_web_bots_remove_custom_provider', { providerId })
}

export function addWebBotAccount(input: {
  providerId: string
  alias: string
  proxyUrl: string | null
  timezone: string | null
  rawCookies: string | null
}): Promise<WebBotsSnapshot> {
  return invokeNative<WebBotsSnapshot>('poc_web_bots_add_account', input)
}

export function updateWebBotAccount(input: {
  providerId: string
  uuid: string
  alias: string
  proxyUrl: string | null
  timezone: string | null
}): Promise<WebBotsSnapshot> {
  return invokeNative<WebBotsSnapshot>('poc_web_bots_update_account', input)
}

export function removeWebBotAccount(providerId: string, uuid: string): Promise<WebBotsSnapshot> {
  return invokeNative<WebBotsSnapshot>('poc_web_bots_remove_account', { providerId, uuid })
}

export function reorderWebBotAccounts(
  providerId: string,
  orderedUuids: string[]
): Promise<WebBotsSnapshot> {
  return invokeNative<WebBotsSnapshot>('poc_web_bots_reorder_accounts', {
    providerId,
    orderedUuids
  })
}

export function switchWebBotAccount(providerId: string, uuid: string): Promise<WebBotsSnapshot> {
  return invokeNative<WebBotsSnapshot>('poc_web_bots_switch_account', { providerId, uuid })
}

export function reloadWebBotAccount(providerId: string, uuid: string): Promise<WebBotsSnapshot> {
  return invokeNative<WebBotsSnapshot>('poc_web_bots_reload_account', { providerId, uuid })
}

export function clearWebBotAccountData(providerId: string, uuid: string): Promise<WebBotsSnapshot> {
  return invokeNative<WebBotsSnapshot>('poc_web_bots_clear_account_data', { providerId, uuid })
}

export function setWebBotViewport(bounds: WebBotViewportBounds): Promise<void> {
  return invokeNative<void>('poc_web_bots_set_viewport', { bounds })
}

export function importWebBotCookies(
  providerId: string,
  uuid: string,
  rawCookies: string
): Promise<WebBotsSnapshot> {
  return invokeNative<WebBotsSnapshot>('poc_web_bots_import_cookies', {
    providerId,
    uuid,
    rawCookies
  })
}

export function exportWebBotCookies(providerId: string, uuid: string): Promise<string> {
  return invokeNative<string>('poc_web_bots_export_cookies', { providerId, uuid })
}

export function testWebBotProxy(
  providerId: string,
  proxyUrl: string | null
): Promise<ProxyTestResult> {
  return invokeNative<ProxyTestResult>('poc_web_bots_test_proxy', { providerId, proxyUrl })
}

export function updateWebBotsSettings(settings: WebBotsSettings): Promise<WebBotsSnapshot> {
  return invokeNative<WebBotsSnapshot>('poc_web_bots_update_settings', { settings })
}

export function upsertWebBotExternalAgent(input: {
  id: string | null
  kind: ExternalAgentKind
  name: string
  baseUrl: string
  apiKey: string
  model: string
  command: string
  args: string[]
  workdir: string | null
}): Promise<WebBotsSnapshot> {
  return invokeNative<WebBotsSnapshot>('poc_web_bots_upsert_external_agent', input)
}

export function deleteWebBotExternalAgent(id: string): Promise<WebBotsSnapshot> {
  return invokeNative<WebBotsSnapshot>('poc_web_bots_delete_external_agent', { id })
}

export function getWebBotSiteAdapters(): Promise<SiteAdaptersSnapshot> {
  return invokeNative<SiteAdaptersSnapshot>('poc_web_bots_get_site_adapters')
}

export function saveWebBotSiteAdapterOverrides(rawJson: string): Promise<SiteAdaptersSnapshot> {
  return invokeNative<SiteAdaptersSnapshot>('poc_web_bots_save_site_adapter_overrides', {
    rawJson
  })
}

export function resetWebBotSiteAdapterOverrides(): Promise<SiteAdaptersSnapshot> {
  return invokeNative<SiteAdaptersSnapshot>('poc_web_bots_reset_site_adapter_overrides')
}

export function createWebBotGroup(input: {
  name: string
  members: AccountKey[]
  workflowMode: GroupWorkflowMode
  maxRelayHops: number | null
  sharedContext: string | null
  sharedSkills: GroupSharedSkill[] | null
  memberRoles: GroupMemberRole[] | null
}): Promise<WebBotsSnapshot> {
  return invokeNative<WebBotsSnapshot>('poc_web_bots_create_group', input)
}

export function updateWebBotGroup(input: {
  groupId: string
  name: string
  members: AccountKey[]
  workflowMode: GroupWorkflowMode
  maxRelayHops: number | null
  sharedContext: string | null
  sharedSkills: GroupSharedSkill[] | null
  memberRoles: GroupMemberRole[] | null
}): Promise<WebBotsSnapshot> {
  return invokeNative<WebBotsSnapshot>('poc_web_bots_update_group', input)
}

export function deleteWebBotGroup(groupId: string): Promise<WebBotsSnapshot> {
  return invokeNative<WebBotsSnapshot>('poc_web_bots_delete_group', { groupId })
}

export function sendWebBotGroupMessage(groupId: string, content: string): Promise<WebBotsSnapshot> {
  return invokeNative<WebBotsSnapshot>('poc_web_bots_send_group_message', { groupId, content })
}

export function clearWebBotGroupMessages(groupId: string): Promise<WebBotsSnapshot> {
  return invokeNative<WebBotsSnapshot>('poc_web_bots_clear_group_messages', { groupId })
}

export function newWebBotGroupTopic(groupId: string): Promise<WebBotsSnapshot> {
  return invokeNative<WebBotsSnapshot>('poc_web_bots_new_group_topic', { groupId })
}

export function retryWebBotGroupMessage(
  groupId: string,
  messageId: string
): Promise<WebBotsSnapshot> {
  return invokeNative<WebBotsSnapshot>('poc_web_bots_retry_group_message', {
    groupId,
    messageId
  })
}

export function syncWebBotAccount(providerId: string, uuid: string): Promise<WebBotsSnapshot> {
  return invokeNative<WebBotsSnapshot>('poc_web_bots_sync_account', { providerId, uuid })
}

export function syncAllWebBotAccounts(): Promise<WebBotsSnapshot> {
  return invokeNative<WebBotsSnapshot>('poc_web_bots_sync_all')
}

export function navigateWebBotAccount(input: {
  providerId: string
  uuid: string
  action: 'back' | 'forward' | 'home' | 'url'
  url?: string | null
}): Promise<string | null> {
  return invokeNative<string | null>('poc_web_bots_navigate', {
    providerId: input.providerId,
    uuid: input.uuid,
    action: input.action,
    url: input.url ?? null
  })
}

export function appendWebBotGroupContext(
  groupId: string,
  snippet: string
): Promise<WebBotsSnapshot> {
  return invokeNative<WebBotsSnapshot>('poc_web_bots_append_group_context', { groupId, snippet })
}

export function exportWebBotsSyncBundle(
  passphrase: string,
  includeCookies: boolean
): Promise<ExportSyncBundleResponse> {
  return invokeNative<ExportSyncBundleResponse>('poc_web_bots_export_sync_bundle', {
    passphrase,
    includeCookies
  })
}

export function importWebBotsSyncBundle(
  bundleJson: string,
  passphrase: string
): Promise<ImportSyncBundleResponse> {
  return invokeNative<ImportSyncBundleResponse>('poc_web_bots_import_sync_bundle', {
    bundleJson,
    passphrase
  })
}

export function subscribeWebBotsState(callback: (snapshot: WebBotsSnapshot) => void): () => void {
  return listenNative<WebBotsSnapshot>('web-bots:state-changed', callback)
}
