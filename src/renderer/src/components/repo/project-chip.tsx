import type React from 'react'
import { RepoIconGlyph } from '@/components/repo/repo-icon'
import { cn } from '@/lib/class-names'
import type { Repo } from '../../../../shared/repository/repo-types'
import { resolveRepoHeaderColor } from '../sidebar/worktree-list/rows/project-header-color'

/** A project's icon and name, the same chip on workspace cards and Activity rows. */
export function ProjectChip({
  repo,
  className,
  ...props
}: { repo: Pick<Repo, 'displayName' | 'repoIcon' | 'badgeColor'> } & Omit<
  React.ComponentProps<'span'>,
  'children'
>): React.JSX.Element {
  return (
    <span
      {...props}
      className={cn(
        'inline-flex h-4 max-w-24 shrink-0 items-center justify-center gap-0.5 rounded-[4px] border border-worktree-sidebar-border bg-worktree-sidebar-accent/55 px-0.5',
        className
      )}
    >
      {/* Why: emoji glyphs scale with font size (0.9em), so pin it to fit the 12px icon box. */}
      <span className="inline-flex size-3 shrink-0 items-center justify-center text-2xs">
        <RepoIconGlyph
          repoIcon={repo.repoIcon}
          color={resolveRepoHeaderColor(repo.badgeColor)}
          className="size-full"
          iconClassName="size-3"
        />
      </span>
      {/* Why: the default folder icon is the same for every project, so the name tells them apart. */}
      <span className="min-w-0 truncate text-3xs leading-3.5 text-muted-foreground lowercase">
        {repo.displayName}
      </span>
    </span>
  )
}
