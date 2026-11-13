// The Project picker's "GitHub" section (cloud-start D4, PROJ-MENU): repositories Orca
// Cloud can reach with no clone on this computer, plus a way to give it access to more. Shown only
// while Orca Cloud is the Run on target.
import React, { useEffect, useMemo, useRef } from 'react'
import { Check, ChevronDown, Cloud, Github, Lock, Plus } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/class-names'
import { useTranslate } from '@/i18n/use-translate'
import type { OrcaCloudGitHubRepository } from '@/lib/orca-cloud/use-orca-cloud-github-repositories'
import {
  ProjectComboboxCloudUnavailable,
  type CloudReposRetry
} from './ProjectComboboxCloudUnavailable'

// Row keys share one namespace with project option ids, and GitHub projects are keyed
// `github:<owner>/<repo>`; this prefix must never collide with a project id.
export const CLOUD_REPO_KEY_PREFIX = 'cloud-only-repo:'
export const CLOUD_REPO_MORE_KEY = 'cloud-only-repo-more-access'
export const CLOUD_REPO_SHOW_MORE_KEY = 'cloud-only-repo-show-more'
export const CLOUD_REPO_RETRY_KEY = 'cloud-only-repo-retry'

/** Runs `open` each time `signal` is bumped (never on mount), with the latest closure. */
export function useOpenOnSignal(signal: number, open: () => void): void {
  const openRef = useRef(open)
  useEffect(() => {
    openRef.current = open
  })
  useEffect(() => {
    if (signal > 0) {
      openRef.current()
    }
  }, [signal])
}

export function cloudRepoKey(fullName: string): string {
  return `${CLOUD_REPO_KEY_PREFIX}${fullName}`
}

/**
 * Commits a cloud-only row (D4). 'kept-open' for Show more, 'handled' for the access link or a
 * listed repository, null for anything else (a project id, Add project). Project ids such as
 * `github:<owner>/<repo>` never match: rows live in their own `cloud-only-repo:` namespace.
 */
export function commitCloudRow(
  key: string,
  rows: {
    cloudRepos: readonly OrcaCloudGitHubRepository[] | null
    cloudReposRetry?: CloudReposRetry | null
    onShowMoreCloudRepos?: (() => void) | null
    onMoreCloudAccess?: () => void
    onCloudRepoSelected?: (fullName: string) => void
  }
): 'kept-open' | 'handled' | null {
  if (key === CLOUD_REPO_RETRY_KEY) {
    // Loading… can't be pressed again; either way the list stays open for the answer.
    if (!rows.cloudReposRetry?.retrying) {
      rows.cloudReposRetry?.retry()
    }
    return 'kept-open'
  }
  if (key === CLOUD_REPO_SHOW_MORE_KEY) {
    rows.onShowMoreCloudRepos?.()
    return 'kept-open'
  }
  if (key === CLOUD_REPO_MORE_KEY) {
    rows.onMoreCloudAccess?.()
    return 'handled'
  }
  if (rows.cloudRepos?.some((repo) => cloudRepoKey(repo.fullName) === key)) {
    rows.onCloudRepoSelected?.(key.slice(CLOUD_REPO_KEY_PREFIX.length))
    return 'handled'
  }
  return null
}

type CloudRowsInput = Parameters<typeof commitCloudRow>[1] & {
  cloudReposRetry?: CloudReposRetry | null
}

/** The picker's cloud rows as one memoized handle: their keys, commit, and the filtered list. */
export function useCloudRows(input: CloudRowsInput): {
  keys: (query: string) => string[]
  commit: (key: string) => ReturnType<typeof commitCloudRow>
  matches: (query: string) => OrcaCloudGitHubRepository[]
} {
  const { cloudRepos, cloudReposRetry, onShowMoreCloudRepos, onMoreCloudAccess } = input
  const { onCloudRepoSelected } = input
  return useMemo(() => {
    const rows = { cloudRepos, cloudReposRetry, onShowMoreCloudRepos }
    const all = { ...rows, onMoreCloudAccess, onCloudRepoSelected }
    return {
      keys: (query) =>
        cloudRowKeys(
          cloudRepos,
          query,
          onShowMoreCloudRepos ?? null,
          onMoreCloudAccess,
          cloudReposRetry ?? null
        ),
      commit: (key) => commitCloudRow(key, all),
      matches: (query) => (cloudRepos ? filterCloudRepos(cloudRepos, query) : [])
    }
  }, [cloudRepos, cloudReposRetry, onCloudRepoSelected, onMoreCloudAccess, onShowMoreCloudRepos])
}

/** Case-insensitive substring match; the list is short and names are owner/repo. */
/** The cloud-only rows' keys, in list order, for the shared keyboard cursor. */
export function cloudRowKeys(
  cloudRepos: readonly OrcaCloudGitHubRepository[] | null,
  query: string,
  onShowMoreCloudRepos: (() => void) | null,
  onMoreCloudAccess: (() => void) | undefined,
  retry: CloudReposRetry | null = null
): string[] {
  if (!cloudRepos) {
    // The arrow keys land on Retry like on any row (design-squad).
    return retry ? [CLOUD_REPO_RETRY_KEY] : []
  }
  return [
    ...filterCloudRepos(cloudRepos, query).map((repo) => cloudRepoKey(repo.fullName)),
    ...(onShowMoreCloudRepos ? [CLOUD_REPO_SHOW_MORE_KEY] : []),
    ...(onMoreCloudAccess ? [CLOUD_REPO_MORE_KEY] : [])
  ]
}

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
  showMoreRepos = false,
  retry = null
}: {
  /** Null while not listed (Orca Cloud not picked, still loading, or the read failed). */
  repos: readonly OrcaCloudGitHubRepository[] | null
  value: string | null
  armedKey: string | null
  armedId: string
  onArm: (key: string) => void
  onCommit: (key: string) => void
  showMoreAccess: boolean
  /** GitHub has more pages than are listed. */
  showMoreRepos?: boolean
  /** GH-LIST-MISSING: the read failed; the section says so with Retry instead of hiding. */
  retry?: CloudReposRetry | null
}): React.JSX.Element | null {
  const t = useTranslate()
  if (!repos) {
    return (
      <ProjectComboboxCloudUnavailable
        retry={retry}
        armed={armedKey === CLOUD_REPO_RETRY_KEY}
        armedId={armedId}
        onArm={() => onArm(CLOUD_REPO_RETRY_KEY)}
        onCommit={() => onCommit(CLOUD_REPO_RETRY_KEY)}
      />
    )
  }
  if (repos.length === 0 && !showMoreAccess) {
    return null
  }
  const heading = t('components.newWorkspace.cloudOnly.headingShort', 'GitHub')
  const cloudOnly = t(
    'components.newWorkspace.cloudOnly.badge',
    'Cloud only. Orca Cloud clones it, so no copy on this computer is needed.'
  )
  const row = (
    key: string,
    children: React.ReactNode,
    accessibleName?: string
  ): React.JSX.Element => (
    <div
      key={key}
      role="option"
      aria-label={accessibleName}
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
      {/* Same style as the picker's other group headers; each row's badge says "cloud only". */}
      <div
        aria-hidden="true"
        className="px-2 pt-2.5 pb-1 text-[11px] font-semibold tracking-[0.05em] text-muted-foreground uppercase"
      >
        {heading}
      </div>
      {repos.map((repo) => {
        const key = cloudRepoKey(repo.fullName)
        const current = value === key
        // One line per row (PROJ-MENU): the name, a lock when private, and the cloud badge. The
        // row's accessible name says all of it, so the badge is never the only signal.
        const accessibleName = repo.private
          ? t('components.newWorkspace.cloudOnly.rowPrivate', '{{repo}}, private, cloud only', {
              repo: repo.fullName
            })
          : t('components.newWorkspace.cloudOnly.rowPublic', '{{repo}}, cloud only', {
              repo: repo.fullName
            })
        return row(
          key,
          <>
            <span className="flex h-5 w-4 shrink-0 items-center justify-center">
              <Github aria-hidden className="size-3.5 text-muted-foreground" />
            </span>
            {/* The lock follows the name so every name starts at the same x. */}
            <span className="flex min-w-0 flex-1 items-center gap-1">
              <span className={cn('min-w-0 truncate', current && 'font-medium')}>
                {repo.fullName}
              </span>
              {repo.private ? (
                <Lock
                  aria-label={t('components.newWorkspace.cloudOnly.privateLabel', 'Private')}
                  className="size-3 shrink-0 text-muted-foreground"
                />
              ) : null}
            </span>
            {current ? (
              <span className="flex h-5 shrink-0 items-center">
                <Check aria-hidden className="size-3.5 text-muted-foreground" />
                <span className="sr-only">
                  {t('auto.components.new.workspace.RunTargetCombobox.currentSuffix', '(current)')}
                </span>
              </span>
            ) : null}
            <Tooltip>
              <TooltipTrigger asChild>
                <span
                  data-cloud-only-badge=""
                  aria-label={cloudOnly}
                  className="flex h-5 shrink-0 items-center text-muted-foreground"
                >
                  <Cloud aria-hidden className="size-3.5" />
                </span>
              </TooltipTrigger>
              <TooltipContent side="right">{cloudOnly}</TooltipContent>
            </Tooltip>
          </>,
          accessibleName
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
