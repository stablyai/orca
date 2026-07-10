import { useRef, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import type { ForkSyncMode, GitForkSyncResult, Repo } from '../../../../shared/types'
import { Button } from '../ui/button'
import { SearchableSetting } from './SearchableSetting'
import { SettingsSegmentedControl } from './SettingsFormControls'
import { syncRuntimeGitForkDefaultBranch } from '../../runtime/runtime-git-client'
import { useAppStore } from '../../store'
import { getRepoOwnerRoutedSettings } from '@/lib/repo-runtime-owner'
import { translate } from '@/i18n/i18n'
import { searchKeywords } from './settings-search-keywords'

type RepositoryForkSyncSectionProps = {
  repo: Repo
  updateRepo: (repoId: string, updates: Pick<Repo, 'forkSyncMode'>) => void
  forceVisible?: boolean
}

function formatForkSyncResult(result: GitForkSyncResult): { title: string; description?: string } {
  const branch =
    result.branchName ??
    translate('auto.components.settings.RepositoryForkSyncSection.defaultBranch', 'default branch')
  if (result.status === 'synced') {
    return {
      title: translate('auto.components.settings.RepositoryForkSyncSection.synced', 'Fork updated'),
      description:
        result.behind === 1
          ? translate(
              'auto.components.settings.RepositoryForkSyncSection.syncedDescriptionSingular',
              'Fast-forwarded {{branch}} by 1 commit.',
              { branch }
            )
          : translate(
              'auto.components.settings.RepositoryForkSyncSection.syncedDescriptionPlural',
              'Fast-forwarded {{branch}} by {{count}} commits.',
              { branch, count: result.behind }
            )
    }
  }
  if (result.status === 'up-to-date') {
    return {
      title: translate(
        'auto.components.settings.RepositoryForkSyncSection.upToDate',
        'Fork already up to date'
      ),
      description: translate(
        'auto.components.settings.RepositoryForkSyncSection.upToDateDescription',
        '{{branch}} already matches upstream.',
        { branch }
      )
    }
  }
  const reasonLabels: Record<NonNullable<GitForkSyncResult['reason']>, string> = {
    'missing-origin': translate(
      'auto.components.settings.RepositoryForkSyncSection.missingOrigin',
      'origin remote is missing.'
    ),
    'missing-upstream': translate(
      'auto.components.settings.RepositoryForkSyncSection.missingUpstream',
      'upstream remote is missing.'
    ),
    'upstream-mismatch': translate(
      'auto.components.settings.RepositoryForkSyncSection.upstreamMismatch',
      'upstream remote no longer matches this fork.'
    ),
    'missing-upstream-default-branch': translate(
      'auto.components.settings.RepositoryForkSyncSection.missingUpstreamBranch',
      'upstream default branch could not be resolved.'
    ),
    'missing-origin-branch': translate(
      'auto.components.settings.RepositoryForkSyncSection.missingOriginBranch',
      'origin does not have the upstream default branch.'
    ),
    diverged: translate(
      'auto.components.settings.RepositoryForkSyncSection.diverged',
      'origin has commits that are not in upstream.'
    )
  }
  const blockedDescription = result.reason ? reasonLabels[result.reason] : undefined
  return {
    title: translate(
      'auto.components.settings.RepositoryForkSyncSection.blocked',
      'Fork sync skipped'
    ),
    description:
      blockedDescription ??
      translate(
        'auto.components.settings.RepositoryForkSyncSection.blockedFallback',
        'Orca could not fast-forward this fork safely.'
      )
  }
}

export function RepositoryForkSyncSection({
  repo,
  updateRepo,
  forceVisible
}: RepositoryForkSyncSectionProps): React.JSX.Element | null {
  const settings = useAppStore((state) => state.settings)
  const upstream = repo.upstream
  const [syncing, setSyncing] = useState(false)
  const syncInFlightRef = useRef(false)
  if (!upstream) {
    return null
  }

  const mode = repo.forkSyncMode ?? 'ask'
  const updateMode = (nextMode: ForkSyncMode) => {
    if (syncing || nextMode === mode) {
      return
    }
    updateRepo(repo.id, { forkSyncMode: nextMode })
    if (nextMode === 'safe-auto') {
      // Why: users enabling automation should immediately learn whether the
      // fork can be fast-forwarded safely instead of waiting for the next reload.
      void syncNow()
    }
  }
  const syncNow = async () => {
    if (syncInFlightRef.current) {
      return
    }
    syncInFlightRef.current = true
    setSyncing(true)
    try {
      const result = await syncRuntimeGitForkDefaultBranch(
        {
          settings: getRepoOwnerRoutedSettings(settings, repo),
          worktreeId: repo.id,
          worktreePath: repo.path,
          connectionId: repo.connectionId ?? undefined
        },
        upstream
      )
      const message = formatForkSyncResult(result)
      if (result.status === 'blocked') {
        toast.message(message.title, { description: message.description })
      } else {
        toast.success(message.title, { description: message.description })
      }
    } catch (error) {
      toast.error(
        translate('auto.components.settings.RepositoryForkSyncSection.failed', 'Fork sync failed'),
        { description: error instanceof Error ? error.message : String(error) }
      )
    } finally {
      syncInFlightRef.current = false
      setSyncing(false)
    }
  }

  return (
    <SearchableSetting
      title={translate(
        'auto.components.settings.RepositoryForkSyncSection.title',
        'Keep Fork Up to Date'
      )}
      description={translate(
        'auto.components.settings.RepositoryForkSyncSection.description',
        'Safely fast-forward this fork from upstream.'
      )}
      keywords={searchKeywords([
        repo.displayName,
        upstream.owner,
        upstream.repo,
        { key: 'auto.components.settings.repository.search.fork', fallback: 'fork' },
        { key: 'auto.components.settings.repository.search.upstream', fallback: 'upstream' },
        { key: 'auto.components.settings.repository.search.syncFork', fallback: 'sync fork' },
        {
          key: 'auto.components.settings.repository.search.keepForkUpToDate',
          fallback: 'keep fork up to date'
        },
        {
          key: 'auto.components.settings.repository.search.fastForward',
          fallback: 'fast-forward'
        },
        {
          key: 'auto.components.settings.repository.search.behindUpstream',
          fallback: 'behind upstream'
        },
        { key: 'auto.components.settings.repository.search.origin', fallback: 'origin' },
        {
          key: 'auto.components.settings.repository.search.defaultBranch',
          fallback: 'default branch'
        }
      ])}
      className="space-y-3"
      forceVisible={forceVisible}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 space-y-1">
          <div className="text-sm font-semibold">
            {translate(
              'auto.components.settings.RepositoryForkSyncSection.title',
              'Keep Fork Up to Date'
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            {translate(
              'auto.components.settings.RepositoryForkSyncSection.longDescription',
              'When this fork is behind upstream, Orca can safely fast-forward its default branch. Orca skips the update if the branch has local-only commits or conflicts.'
            )}
          </p>
          <p className="text-xs text-muted-foreground">
            {translate(
              'auto.components.settings.RepositoryForkSyncSection.forkOf',
              'Fork of {{owner}}/{{repo}}',
              { owner: upstream.owner, repo: upstream.repo }
            )}
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => void syncNow()}
          disabled={syncing}
          className="shrink-0"
        >
          <RefreshCw className={syncing ? 'size-3.5 animate-spin' : 'size-3.5'} />
          {syncing
            ? translate('auto.components.settings.RepositoryForkSyncSection.syncing', 'Syncing')
            : translate('auto.components.settings.RepositoryForkSyncSection.syncNow', 'Sync Now')}
        </Button>
      </div>
      <SettingsSegmentedControl<ForkSyncMode>
        value={mode}
        onChange={updateMode}
        ariaLabel={translate(
          'auto.components.settings.RepositoryForkSyncSection.modeLabel',
          'Fork sync mode'
        )}
        size="sm"
        options={[
          {
            value: 'ask',
            label: translate('auto.components.settings.RepositoryForkSyncSection.ask', 'Ask'),
            disabled: syncing
          },
          {
            value: 'safe-auto',
            label: translate(
              'auto.components.settings.RepositoryForkSyncSection.safeAuto',
              'Safe Auto'
            ),
            disabled: syncing
          },
          {
            value: 'off',
            label: translate('auto.components.settings.RepositoryForkSyncSection.off', 'Off'),
            disabled: syncing
          }
        ]}
      />
    </SearchableSetting>
  )
}
