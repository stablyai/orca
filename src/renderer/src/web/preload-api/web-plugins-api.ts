import type { PreloadApi } from '../../../../preload/api-types'
import type { PluginConsentRequest } from '../../../../shared/plugins/approval/plugin-consent-request'
import type { PluginHostListEntry } from '../../../../shared/plugins/plugin-list-entry'
import { callRuntimeResult } from '../runtime/client/web-runtime-calls'
import { noopUnsubscribe } from './web-storage'

type PluginPanelEntry = NonNullable<
  Awaited<ReturnType<NonNullable<PreloadApi['plugins']>['readPanelEntry']>>
>
type PluginPanelActionOutcome = Awaited<
  ReturnType<NonNullable<PreloadApi['plugins']>['panelAction']>
>

/** Runtime-backed plugin operations shared by browser clients and Tauri. */
export function createWebPluginsApi(): NonNullable<Partial<PreloadApi>['plugins']> {
  return {
    list: () => callRuntimeResult<PluginHostListEntry[]>('plugins.list'),
    listLanguagePacks: () => callRuntimeResult('plugins.listLanguagePacks'),
    listThemes: () => Promise.resolve([]),
    listTerminalThemes: () => Promise.resolve([]),
    listIconThemes: () => Promise.resolve([]),
    loadIconTheme: () => Promise.resolve(null),
    listSyntaxes: () => Promise.resolve([]),
    loadSyntax: () => Promise.resolve(null),
    resolveGitSource: () => Promise.reject(new Error('unsupported')),
    suggestForFileType: () => Promise.resolve(null),
    getRollbackVersion: () => Promise.resolve(null),
    getInstalledManifest: () => Promise.resolve(null),
    getAutoUpdateState: () => Promise.reject(new Error('unsupported')),
    takeUpdateReviewNotices: () => Promise.resolve([]),
    getInstallCounts: () => Promise.resolve({}),
    onInstallCountsChanged: () => noopUnsubscribe,
    onAutoUpdateChanged: () => noopUnsubscribe,
    consent: (args: PluginConsentRequest) =>
      callRuntimeResult<PluginHostListEntry[]>('plugins.consent', args),
    setEnabled: (args) => callRuntimeResult<PluginHostListEntry[]>('plugins.setEnabled', args),
    readPanelEntry: (args: { pluginKey: string; panelId: string }) =>
      callRuntimeResult<PluginPanelEntry | null>('plugins.readPanelEntry', args),
    invokeCommand: (args: { pluginKey: string; commandId: string; args?: unknown }) =>
      callRuntimeResult('plugins.invokeCommand', args),
    panelAction: async (args: {
      sessionToken: string
      action: string
      params?: unknown
    }): Promise<PluginPanelActionOutcome> =>
      (await callRuntimeResult<{ outcome: PluginPanelActionOutcome }>('plugins.panelAction', args))
        .outcome,
    install: (source) => callRuntimeResult('plugins.install', source),
    listMarketplaces: () => callRuntimeResult('plugins.listMarketplaces'),
    addMarketplace: (source) => callRuntimeResult('plugins.addMarketplace', source),
    removeMarketplace: (args) => callRuntimeResult('plugins.removeMarketplace', args),
    refreshMarketplaces: (args = {}) => callRuntimeResult('plugins.refreshMarketplaces', args),
    listMarketplacePlugins: () => callRuntimeResult('plugins.listMarketplacePlugins'),
    previewMarketplacePlugin: (args) => callRuntimeResult('plugins.previewMarketplacePlugin', args),
    installMarketplacePlugin: (preview) =>
      callRuntimeResult('plugins.installMarketplacePlugin', preview),
    previewMarketplaceUpdate: (args) => callRuntimeResult('plugins.previewMarketplaceUpdate', args),
    rollbackMarketplacePlugin: (args) =>
      callRuntimeResult('plugins.rollbackMarketplacePlugin', args),
    remove: (args) => callRuntimeResult('plugins.remove', args),
    getLogs: (args) => callRuntimeResult('plugins.getLogs', args),
    refresh: () => callRuntimeResult<PluginHostListEntry[]>('plugins.list'),
    onChanged: () => noopUnsubscribe
  }
}
