import { create } from 'zustand'
import { toast } from 'sonner'
import {
  parsePluginInstallLink,
  type PluginInstallLink
} from '../../../shared/plugins/catalog/plugin-install-link'
import type { PluginMarketplaceGitSource } from '../../../shared/plugins/catalog/plugin-marketplace'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'

type PluginPreviewRequest = { marketplaceSourceId: string; pluginKey: string }
/** A linked catalog awaiting the user's "Add catalog?" answer; nothing is fetched before it. */
export type PluginCatalogToAdd = { pluginKey: string; source: PluginMarketplaceGitSource }

/** A catalog plugin asked for from outside Settings; the plugin manager opens its page. An install link
 *  waits here while plugins are off, so turning them on lands on the page. */
export const usePluginPreviewRequestStore = create<{
  request: PluginPreviewRequest | null
  link: PluginInstallLink | null
  catalogToAdd: PluginCatalogToAdd | null
}>()(() => ({ request: null, link: null, catalogToAdd: null }))

export function requestPluginPreview(request: PluginPreviewRequest): void {
  usePluginPreviewRequestStore.setState({ request })
}

/** An `orca://plugins/...` link: opens Settings → Plugins at that plugin; never installs. */
export function openPluginInstallLink(raw: string): void {
  const link = parsePluginInstallLink(raw)
  if (!link) {
    toast.error(
      translate('auto.store.pluginInstallLink.invalid', 'That plugin link isn’t valid.'),
      { id: 'plugin-install-link-invalid' }
    )
    return
  }
  usePluginPreviewRequestStore.setState({ link })
  const state = useAppStore.getState()
  state.openSettingsTarget({ pane: 'plugins', repoId: null })
  state.openSettingsPage()
}
