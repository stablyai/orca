import { useEffect } from 'react'
import type { Repo } from '../../../../shared/types'
import {
  getRepoExecutionHostId,
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { SearchableSetting } from './SearchableSetting'
import { useAppStore } from '../../store'
import { translate } from '@/i18n/i18n'
import { searchKeywords } from './settings-search-keywords'

const INHERIT_VALUE = '__inherit__'

type RepositoryBrowserProfileSectionProps = {
  repo: Repo
  updateRepo: (
    repoId: string,
    updates: { defaultBrowserSessionProfileId?: Repo['defaultBrowserSessionProfileId'] | null }
  ) => void
  forceVisible?: boolean
}

// Why: profiles exist only on local and runtime hosts, so SSH projects browse through the local host.
function getRepoBrowserSessionHostId(repo: Repo): ExecutionHostId {
  const hostId = getRepoExecutionHostId(repo)
  return parseExecutionHostId(hostId)?.kind === 'runtime' ? hostId : LOCAL_EXECUTION_HOST_ID
}

export function RepositoryBrowserProfileSection({
  repo,
  updateRepo,
  forceVisible
}: RepositoryBrowserProfileSectionProps): React.JSX.Element {
  const hostId = getRepoBrowserSessionHostId(repo)
  const profiles = useAppStore((s) => s.browserSessionProfilesByHostId[hostId])
  const fetchBrowserSessionProfiles = useAppStore((s) => s.fetchBrowserSessionProfiles)

  useEffect(() => {
    // Why: this pane can be the first surface to need the host's profiles — Settings › Browser may never have been opened.
    if (!profiles) {
      void fetchBrowserSessionProfiles(hostId)
    }
  }, [fetchBrowserSessionProfiles, hostId, profiles])

  const title = translate(
    'auto.components.settings.RepositoryBrowserProfileSection.title',
    'Browser Profile'
  )
  const description = translate(
    'auto.components.settings.RepositoryBrowserProfileSection.description',
    'Choose the browser profile for new tabs opened in this project.'
  )

  return (
    <SearchableSetting
      title={title}
      description={description}
      keywords={searchKeywords([
        repo.displayName,
        {
          key: 'auto.components.settings.repository.search.browserProfile',
          fallback: 'browser profile'
        },
        { key: 'auto.components.settings.repository.search.session', fallback: 'session' },
        { key: 'auto.components.settings.repository.search.cookies', fallback: 'cookies' },
        { key: 'auto.components.settings.repository.search.account', fallback: 'account' }
      ])}
      className="space-y-3"
      id={`repo-browser-profile-${repo.id}`}
      forceVisible={forceVisible}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 space-y-1">
          <div className="text-sm font-semibold">{title}</div>
          <p className="text-xs text-muted-foreground">
            {translate(
              'auto.components.settings.RepositoryBrowserProfileSection.longDescription',
              'New browser tabs opened in this project use this profile instead of the app-wide default. Per-tab switching still works from the ··· toolbar menu.'
            )}
          </p>
        </div>
        <Select
          value={repo.defaultBrowserSessionProfileId ?? INHERIT_VALUE}
          onValueChange={(value) =>
            updateRepo(repo.id, {
              defaultBrowserSessionProfileId: value === INHERIT_VALUE ? null : value
            })
          }
        >
          <SelectTrigger size="sm" className="max-w-48 shrink-0">
            <SelectValue />
          </SelectTrigger>
          <SelectContent align="end">
            <SelectItem value={INHERIT_VALUE}>
              {translate(
                'auto.components.settings.RepositoryBrowserProfileSection.inherit',
                'Use app default'
              )}
            </SelectItem>
            {(profiles ?? []).map((profile) => (
              <SelectItem key={profile.id} value={profile.id}>
                {profile.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </SearchableSetting>
  )
}
