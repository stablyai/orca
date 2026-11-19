import React from 'react'
import { useAppStore } from '@/store'
import { cn } from '@/lib/class-names'
import type { Repo } from '../../../../shared/repository/repo-types'
import {
  repoMarkKey,
  resolveRepoMarkAppearances,
  type RepoMarkAppearance
} from '../../../../shared/repository/appearance/repo-mark-appearance'
import {
  DEFAULT_REPO_BADGE_COLOR,
  resolveRepoBadgeColor
} from '../../../../shared/repository/appearance/repo-badge-color'
import { RepoIconGlyph } from './repo-icon'

type RepoMarkRepo = Pick<
  Repo,
  'id' | 'badgeColor' | 'repoIcon' | 'addedAt' | 'executionHostId' | 'connectionId'
>

// Every card asks for its mark; resolve the whole catalog once per repos snapshot.
const appearancesByRepos = new WeakMap<readonly Repo[], Map<string, RepoMarkAppearance>>()

function appearancesFor(repos: readonly Repo[]): Map<string, RepoMarkAppearance> {
  let appearances = appearancesByRepos.get(repos)
  if (!appearances) {
    appearances = resolveRepoMarkAppearances(repos)
    appearancesByRepos.set(repos, appearances)
  }
  return appearances
}

export function useRepoMarkAppearance(repo: RepoMarkRepo): RepoMarkAppearance {
  const repos = useAppStore((state) => state.repos)
  return (
    appearancesFor(repos).get(repoMarkKey(repo)) ?? {
      color: resolveRepoBadgeColor(repo.badgeColor)
    }
  )
}

/** What Auto would pick for this project right now, so the Auto swatch can preview it. */
export function useRepoAutoMarkColor(repo: RepoMarkRepo): string {
  const repos = useAppStore((state) => state.repos)
  const key = repoMarkKey(repo)
  return React.useMemo(() => {
    const asAuto = repos.map((candidate) =>
      repoMarkKey(candidate) === key
        ? { ...candidate, badgeColor: DEFAULT_REPO_BADGE_COLOR }
        : candidate
    )
    return resolveRepoMarkAppearances(asAuto).get(key)?.color ?? DEFAULT_REPO_BADGE_COLOR
  }, [repos, key])
}

const MARK_SIZES = {
  // Why: emoji glyphs scale with font size (0.9em), so the text size pins them to the icon box.
  sm: { box: 'size-4 rounded-[4px] text-2xs', icon: 'size-3' },
  md: { box: 'size-4 rounded-[4px] text-xs', icon: 'size-3.5' }
} as const

export function RepoMarkView({
  repoIcon,
  appearance,
  size = 'sm',
  className
}: {
  repoIcon: Repo['repoIcon']
  appearance: RepoMarkAppearance
  size?: keyof typeof MARK_SIZES
  className?: string
}): React.JSX.Element {
  const sizes = MARK_SIZES[size]
  // Letters are their own colored chip, so they fill the mark instead of sitting inset.
  const glyphSize = repoIcon?.type === 'letters' ? 'size-4' : sizes.icon
  return (
    <span
      aria-hidden="true"
      className={cn(
        'inline-flex shrink-0 items-center justify-center overflow-hidden',
        sizes.box,
        className
      )}
    >
      <RepoIconGlyph
        repoIcon={repoIcon}
        color={appearance.color}
        className={glyphSize}
        iconClassName={glyphSize}
      />
    </span>
  )
}

/** The card-header mark: one tile shape for lucide, emoji and avatar icons alike. */
export function RepoMarkTile({
  repoIcon,
  appearance,
  className
}: {
  repoIcon: Repo['repoIcon']
  appearance: RepoMarkAppearance
  className?: string
}): React.JSX.Element {
  const neutral = appearance.color === DEFAULT_REPO_BADGE_COLOR
  const image = repoIcon?.type === 'image'
  const letters = repoIcon?.type === 'letters'
  return (
    <span
      aria-hidden="true"
      className={cn(
        'inline-flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-[10px] text-[22px]',
        // Images fill the tile edge to edge; a hairline keeps dark avatars off the dark card.
        image
          ? 'ring-1 ring-border ring-inset'
          : !letters && neutral && 'bg-muted ring-1 ring-border ring-inset',
        className
      )}
      style={
        // Letters and pictures carry their own colors; only glyphs sit on a tint.
        letters || image || neutral
          ? undefined
          : {
              backgroundColor: `color-mix(in srgb, ${appearance.color} 16%, transparent)`,
              boxShadow: `inset 0 0 0 1px color-mix(in srgb, ${appearance.color} 32%, transparent)`
            }
      }
    >
      <RepoIconGlyph
        repoIcon={repoIcon}
        // Letters and images fill the tile edge to edge; glyphs sit centered in the tint.
        color={letters ? appearance.color : neutral ? undefined : appearance.color}
        className={image || letters ? 'size-full rounded-none' : 'size-[22px]'}
        iconClassName={
          image
            ? 'size-full rounded-none object-cover'
            : letters
              ? 'size-full rounded-none'
              : 'size-[22px]'
        }
      />
    </span>
  )
}

export function RepoMark({
  repo,
  size,
  className
}: {
  repo: RepoMarkRepo
  size?: keyof typeof MARK_SIZES
  className?: string
}): React.JSX.Element {
  const appearance = useRepoMarkAppearance(repo)
  return (
    <RepoMarkView
      repoIcon={repo.repoIcon}
      appearance={appearance}
      size={size}
      className={className}
    />
  )
}
