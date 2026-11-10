// The Project picker's "On GitHub · Orca Cloud only" section (cloud-start D4): repositories Orca
// Cloud can reach with no clone on this computer, plus a way to give it access to more. Shown only
// while Orca Cloud is the Run on target.
import React from 'react'
import { Check, ChevronDown, Github, Plus } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useTranslate } from '@/i18n/use-translate'
import type { OrcaCloudGitHubRepository } from '@/lib/orca-cloud/use-orca-cloud-github-repositories'

export const CLOUD_REPO_KEY_PREFIX = 'github:'
export const CLOUD_REPO_MORE_KEY = 'github-more-access'
export const CLOUD_REPO_SHOW_MORE_KEY = 'github-show-more'

export function cloudRepoKey(fullName: string): string {
  return `${CLOUD_REPO_KEY_PREFIX}${fullName}`
}

/** Case-insensitive substring match; the list is short and names are owner/repo. */
export function filterCloudRepos(
  repos: readonly OrcaCloudGitHubRepository[],
  query: string
): OrcaCloudGitHubRepository[] {
  const needle = query.trim().toLowerCase()
  return needle ? repos.filter((repo) => repo.fullName.toLowerCase().includes(needle)) : [...repos]
}

export function ProjectComboboxCloudSection({
  repos,
  value,
  armedKey,
  armedId,
  onArm,
  onCommit,
  showMoreAccess,
  showMoreRepos = false
}: {
  repos: readonly OrcaCloudGitHubRepository[]
  value: string | null
  armedKey: string | null
  armedId: string
  onArm: (key: string) => void
  onCommit: (key: string) => void
  showMoreAccess: boolean
  /** GitHub has more pages than are listed. */
  showMoreRepos?: boolean
}): React.JSX.Element | null {
  const t = useTranslate()
  if (repos.length === 0 && !showMoreAccess) {
    return null
  }
  const heading = t('components.newWorkspace.cloudOnly.heading', 'On GitHub · Orca Cloud only')
  const row = (key: string, children: React.ReactNode): React.JSX.Element => (
    <div
      key={key}
      role="option"
      id={armedKey === key ? armedId : undefined}
      aria-selected={armedKey === key}
      data-armed={armedKey === key || undefined}
      onMouseDown={(event) => event.preventDefault()}
      onMouseMove={() => onArm(key)}
      onClick={() => onCommit(key)}
      className={cn(
        'flex cursor-default items-start gap-2 rounded-sm px-2 py-1.5 text-sm',
        armedKey === key && 'bg-accent text-accent-foreground'
      )}
    >
      {children}
    </div>
  )
  return (
    <div role="group" aria-label={heading}>
      <div aria-hidden="true" className="px-2 pt-2.5 pb-1">
        <div className="text-[11px] font-semibold tracking-[0.05em] text-muted-foreground uppercase">
          {heading}
        </div>
        {/* Said once for the section; rows carry what tells them apart. */}
        <div className="text-xs text-muted-foreground">
          {t(
            'components.newWorkspace.cloudOnly.detail',
            'Orca Cloud clones it. No copy on this computer needed.'
          )}
        </div>
      </div>
      {repos.map((repo) => {
        const key = cloudRepoKey(repo.fullName)
        const current = value === key
        return row(
          key,
          <>
            <span className="flex h-5 w-4 shrink-0 items-center justify-center">
              <Github aria-hidden className="size-3.5 text-muted-foreground" />
            </span>
            <span className="flex min-w-0 flex-1 flex-col">
              <span className={cn('min-w-0 truncate', current && 'font-medium')}>
                {repo.fullName}
              </span>
              <span className="min-w-0 truncate text-xs text-muted-foreground">
                {repo.private
                  ? t('components.newWorkspace.cloudOnly.private', '{{owner}} · Private', {
                      owner: repo.fullName.split('/')[0] ?? repo.fullName
                    })
                  : t('components.newWorkspace.cloudOnly.public', '{{owner}} · Public', {
                      owner: repo.fullName.split('/')[0] ?? repo.fullName
                    })}
              </span>
            </span>
            {current ? (
              <span className="flex h-5 shrink-0 items-center">
                <Check aria-hidden className="size-3.5 text-muted-foreground" />
                <span className="sr-only">
                  {t('auto.components.new.workspace.RunTargetCombobox.currentSuffix', '(current)')}
                </span>
              </span>
            ) : null}
          </>
        )
      })}
      {showMoreRepos
        ? row(
            CLOUD_REPO_SHOW_MORE_KEY,
            <>
              <span className="flex h-5 w-4 shrink-0 items-center justify-center">
                <ChevronDown aria-hidden className="size-3.5 text-muted-foreground" />
              </span>
              <span className="min-w-0 truncate text-muted-foreground">
                {t('components.newWorkspace.cloudOnly.showMore', 'Show more repositories…')}
              </span>
            </>
          )
        : null}
      {showMoreAccess
        ? row(
            CLOUD_REPO_MORE_KEY,
            <>
              <span className="flex h-5 w-4 shrink-0 items-center justify-center">
                <Plus aria-hidden className="size-3.5 text-muted-foreground" />
              </span>
              <span className="min-w-0 truncate text-muted-foreground">
                {t(
                  'components.newWorkspace.cloudOnly.moreAccess',
                  'Give Orca Cloud access to more repositories…'
                )}
              </span>
            </>
          )
        : null}
    </div>
  )
}
