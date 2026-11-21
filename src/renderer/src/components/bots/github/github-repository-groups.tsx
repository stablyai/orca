import React, { useState } from 'react'
import { BookMarked, Building2, ChevronRight } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import type { ConnectorGitHubInstallation } from '../../../../../shared/connector-bot-github-contract'

const ROW = 'flex h-8 min-w-0 items-center gap-2 rounded-md px-2 text-sm'

/** One row per account or organization the Orca app is on, with its repositories folded under it. */
export function GitHubRepositoryGroups({
  installations,
  newInstalls
}: {
  installations: readonly ConnectorGitHubInstallation[]
  /** Installs the last trip to GitHub added, marked New. */
  newInstalls: ReadonlySet<string>
}): React.JSX.Element {
  return (
    // Six and a half rows at most, the half row showing it scrolls; the footer stays on screen.
    <ul className="max-h-[218px] overflow-y-auto rounded-lg border border-border p-1 scrollbar-sleek">
      {installations.map((installation) => (
        <GitHubRepositoryGroup
          key={installation.installationId}
          installation={installation}
          isNew={newInstalls.has(installation.installationId)}
        />
      ))}
    </ul>
  )
}

function GitHubRepositoryGroup({
  installation,
  isNew
}: {
  installation: ConnectorGitHubInstallation
  isNew: boolean
}): React.JSX.Element {
  const t = useTranslate()
  const [open, setOpen] = useState(false)
  const { accountLogin, repositories } = installation
  const name = (
    <>
      <Building2 className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      <span className="min-w-0 flex-1 truncate text-left" title={accountLogin}>
        {accountLogin}
      </span>
      {isNew ? (
        <span className="shrink-0 text-xs text-muted-foreground">
          {t('bots.github.setup.new', 'New')}
        </span>
      ) : null}
    </>
  )
  // The whole account: nothing to list here, GitHub adds each new repository by itself.
  if (repositories === null) {
    return (
      <li className={ROW}>
        {name}
        <span className="shrink-0 text-xs whitespace-nowrap text-muted-foreground">
          {t('bots.github.setup.allRepos', 'All repos')}
        </span>
      </li>
    )
  }
  return (
    <li>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((was) => !was)}
        className={cn(
          ROW,
          'w-full outline-none hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50'
        )}
      >
        {name}
        <span className="flex shrink-0 items-center gap-1 text-xs whitespace-nowrap text-muted-foreground">
          {t('bots.github.setup.repoCount', '{{count}} repos', {
            count: repositories.length,
            defaultValue_one: '{{count}} repo'
          })}
          <ChevronRight
            className={cn('size-3.5 transition-transform', open && 'rotate-90')}
            aria-hidden
          />
        </span>
      </button>
      {open ? (
        <ul>
          {repositories.map((repository) => (
            <li key={repository.fullName} className={cn(ROW, 'pl-8')}>
              <BookMarked className="size-4 shrink-0 text-muted-foreground" aria-hidden />
              <span className="min-w-0 flex-1 truncate" title={repository.fullName}>
                {repository.fullName.slice(repository.fullName.indexOf('/') + 1)}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  )
}
