import { useMemo } from 'react'
import {
  isPluginLanguagePackRegistration,
  type PluginLanguagePackRegistration
} from '../../../shared/plugins/artifacts/plugin-language-pack-artifact'
import { isUsablePluginLanguagePack } from '../../../shared/plugins/plugin-language-pack-coverage'
import { createPluginContentListStore } from './plugin-content-list-store'

const languagePacks = createPluginContentListStore<PluginLanguagePackRegistration>({
  kind: 'language packs',
  list: (api) => api.listLanguagePacks,
  isEntry: isPluginLanguagePackRegistration
})

export const usePluginLanguagePackStore = languagePacks.useStore
export const ensurePluginLanguagePacksLoaded = languagePacks.ensureLoaded
/** Packs complete enough to switch the UI to. */
export function usePluginLanguagePacks(): PluginLanguagePackRegistration[] {
  const entries = languagePacks.useEntries()
  return useMemo(() => {
    const usable = entries.filter(isUsablePluginLanguagePack)
    return usable.length === entries.length ? entries : usable
  }, [entries])
}
