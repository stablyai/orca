import type { SettingsSearchEntry } from '../search/settings-search'
import { translate } from '@/i18n/i18n'
import { translateSearchKeyword } from '../search/settings-search-keywords'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'

export const getCopyOnWriteCheckoutsSearchEntry = createLocalizedCatalog(
  (): SettingsSearchEntry => ({
    title: translate(
      'auto.components.settings.copyOnWriteCheckouts.title',
      'Copy-on-write workspaces'
    ),
    description: translate(
      'auto.components.settings.copyOnWriteCheckouts.description',
      "New workspaces share disk space with the project's files until you change them. Git still checks every file, so each workspace matches a normal checkout. Only works when the workspace is on the same APFS disk as the project."
    ),
    keywords: [
      ...translateSearchKeyword(
        'auto.components.settings.experimental.search.0d24759f14',
        'experimental'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.copyOnWriteCheckouts.keywordApfs',
        'apfs'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.copyOnWriteCheckouts.keywordClone',
        'clone'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.copyOnWriteCheckouts.keywordDisk',
        'disk space'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.copyOnWriteCheckouts.keywordWorktree',
        'worktree'
      )
    ],
    targetSectionId: 'copy-on-write-checkouts'
  })
)
