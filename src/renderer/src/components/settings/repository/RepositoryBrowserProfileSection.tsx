import { useEffect, useId, useState } from 'react'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import type { Repo } from '../../../../../shared/repository/repo-types'
import {
  getRepoExecutionHostId,
  LOCAL_EXECUTION_HOST_ID
} from '../../../../../shared/execution-host/execution-host'
import { getBrowserProfileHostId } from '@/store/slices/browser/hosts/browser-host-state'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue
} from '../../ui/select'
import { SearchableSetting } from '../section-layout/SearchableSetting'
import type { SettingsSearchEntry } from '../search/settings-search'
import { searchKeywordTranslator } from '../search/settings-search-keywords'

// Radix forbids empty item values; this one means "follow the Browser setting".
const INHERIT_VALUE = '__browser_setting__'

export function getRepositoryBrowserProfileSearchEntry(
  t: Translate = translate
): SettingsSearchEntry {
  const keyword = searchKeywordTranslator(t)
  return {
    title: t('components.RepositoryBrowserProfileSection.title', 'Browser profile'),
    description: t(
      'components.RepositoryBrowserProfileSection.description',
      'New browser tabs in this project, including ones agents open, use this profile. Point several projects at one profile to share a sign-in.'
    ),
    keywords: [
      ...keyword('components.RepositoryBrowserProfileSection.keywordProfile', 'browser profile'),
      ...keyword('components.RepositoryBrowserProfileSection.keywordCookies', 'cookies'),
      ...keyword('components.RepositoryBrowserProfileSection.keywordSignIn', 'sign in')
    ]
  }
}

export function RepositoryBrowserProfileSection({
  repo,
  updateRepo,
  forceVisible = false
}: {
  repo: Repo
  updateRepo: (
    repoId: string,
    updates: { browserProfileId: string | null }
  ) => void | Promise<boolean>
  forceVisible?: boolean
}): React.JSX.Element {
  const t = useTranslate()
  const entry = getRepositoryBrowserProfileSearchEntry(t)
  const selectLabelId = useId()
  const [saveFailed, setSaveFailed] = useState(false)
  const [saving, setSaving] = useState(false)
  const profileHostId = getBrowserProfileHostId(getRepoExecutionHostId(repo))
  const profiles = useAppStore((s) => s.browserSessionProfilesByHostId[profileHostId])
  const fetchProfiles = useAppStore((s) => s.fetchBrowserSessionProfiles)
  const scopeSetting = useAppStore((s) => s.settings?.browserProfileScope ?? 'shared')
  // Why: the per-repo/workspace scopes apply only to pages on this desktop; a paired runtime uses its default.
  const scope = profileHostId === LOCAL_EXECUTION_HOST_ID ? scopeSetting : 'shared'

  useEffect(() => {
    void fetchProfiles(profileHostId)
  }, [fetchProfiles, profileHostId])

  // A real listing always has Default; a cache holding only an adopted managed profile is not one.
  const loaded = Boolean(profiles?.some((profile) => profile.id === 'default'))
  const picked = repo.browserProfileId
  // Orca-managed repo/workspace profiles go away with their owner, so they're offered only when already picked.
  const choices = (profiles ?? []).filter((profile) => !profile.owner || profile.id === picked)
  const pickMissing = Boolean(picked) && loaded && !choices.some((p) => p.id === picked)
  const value = picked || INHERIT_VALUE
  const scopeLabel =
    scope === 'repo'
      ? t('settings.browser.profileScope.optionRepo', 'Per repo')
      : scope === 'worktree'
        ? t('settings.browser.profileScope.optionWorktree', 'Per workspace')
        : t('settings.browser.profileScope.optionShared', 'Shared')

  return (
    <SearchableSetting
      title={entry.title}
      description={entry.description}
      keywords={[repo.displayName, ...(entry.keywords ?? [])]}
      className="space-y-3 py-3"
      forceVisible={forceVisible}
    >
      <div className="min-w-0 space-y-1">
        <div className="text-sm font-semibold">{entry.title}</div>
        <p className="text-xs text-muted-foreground">{entry.description}</p>
      </div>
      <div className="space-y-1.5">
        <span id={selectLabelId} className="text-xs text-muted-foreground">
          {t('components.RepositoryBrowserProfileSection.selectLabel', 'Profile for new tabs')}
        </span>
        <Select
          value={value}
          disabled={!loaded || saving}
          onValueChange={(next) => {
            if (next === value) {
              return
            }
            setSaveFailed(false)
            // Why: the row updates only when the host answers, so a second pick before then would be lost.
            setSaving(true)
            void Promise.resolve(
              updateRepo(repo.id, { browserProfileId: next === INHERIT_VALUE ? null : next })
            )
              .then((saved) => setSaveFailed(saved === false))
              .catch(() => setSaveFailed(true))
              .finally(() => setSaving(false))
          }}
        >
          <SelectTrigger size="sm" className="w-full" aria-labelledby={selectLabelId}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={INHERIT_VALUE}>
              {t(
                'components.RepositoryBrowserProfileSection.inherit',
                'Browser setting ({{scope}})',
                { scope: scopeLabel }
              )}
            </SelectItem>
            <SelectSeparator />
            {pickMissing && picked ? (
              // A distinct value, so choosing the Browser setting still clears the stale pick.
              <SelectItem value={picked} disabled>
                {t('components.RepositoryBrowserProfileSection.deletedOption', 'Deleted profile')}
              </SelectItem>
            ) : null}
            {choices.map((profile) => (
              <SelectItem key={profile.id} value={profile.id}>
                {profile.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {pickMissing ? (
        <p className="text-xs text-muted-foreground">
          {t(
            'components.RepositoryBrowserProfileSection.deleted',
            'The profile picked for this project was deleted, so new tabs follow the Browser setting.'
          )}
        </p>
      ) : null}
      {saveFailed ? (
        <p className="text-xs text-destructive">
          {t(
            'components.RepositoryBrowserProfileSection.saveFailed',
            "Couldn't save the browser profile. The Orca on this project's host may need an update."
          )}
        </p>
      ) : null}
    </SearchableSetting>
  )
}
