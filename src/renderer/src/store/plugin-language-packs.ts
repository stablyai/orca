import {
  isPluginLanguagePackRegistration,
  type PluginLanguagePackRegistration
} from '../../../shared/plugins/plugin-language-pack-artifact'
import { createPluginContentListStore } from './plugin-content-list-store'

const languagePacks = createPluginContentListStore<PluginLanguagePackRegistration>({
  kind: 'language packs',
  list: (api) => api.listLanguagePacks,
  isEntry: isPluginLanguagePackRegistration
})

export const usePluginLanguagePackStore = languagePacks.useStore
export const ensurePluginLanguagePacksLoaded = languagePacks.ensureLoaded
export const usePluginLanguagePacks = languagePacks.useEntries
