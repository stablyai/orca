import { useTranslate } from '@/i18n/use-translate'
import { SettingsGroup } from '../section-layout/SettingsGroup'
import { SettingsNavigationRow } from '../form-controls/SettingsNavigationRow'
import { matchesSettingsSearch, rankSettingsSearchItems } from '../search/settings-search'
import { getGeneralEditorSearchDescriptors } from '../editor/general-editor-search'
import { getGeneralWorkspaceSearchDescriptors } from './general-search'
import { getGeneralSubPageTitle, type GeneralSubPage } from './general-sub-pages'

export function GeneralSearchResults({
  query,
  onSelect
}: {
  query: string
  onSelect: (page: GeneralSubPage, sectionId?: string) => void
}): React.JSX.Element {
  const t = useTranslate()
  const descriptors = [
    ...getGeneralWorkspaceSearchDescriptors(),
    ...getGeneralEditorSearchDescriptors()
  ]
  const pages: GeneralSubPage[] = ['folder', 'worktrees', 'open-in', 'editor']
  return (
    <>
      {pages.map((page) => {
        const title = getGeneralSubPageTitle(page, t)
        const matches = rankSettingsSearchItems(
          query,
          descriptors.filter((descriptor) => descriptor.page === page),
          (descriptor) => [descriptor.entry]
        )
        if (matches.length === 0 && !matchesSettingsSearch(query, { title })) {
          return null
        }
        return (
          <SettingsGroup key={page} title={title}>
            {matches.length > 0 ? (
              matches.map(({ item }) => (
                <SettingsNavigationRow
                  key={item.sectionId}
                  title={item.entry.title}
                  description={item.entry.description}
                  onClick={() => onSelect(page, item.sectionId)}
                />
              ))
            ) : (
              <SettingsNavigationRow title={title} onClick={() => onSelect(page)} />
            )}
          </SettingsGroup>
        )
      })}
    </>
  )
}
