import React from 'react'
import { useAppStore } from '@/store'
import { cn } from '@/lib/class-names'
import type { Repo } from '../../../../shared/repository/repo-types'
import type { GlobalSettings } from '../../../../shared/settings/global-settings-types'
import type { DefaultProjectBadgeStyle } from '../../../../shared/ui-chrome/ui-chrome-types'
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

export type RepoMarkRepo = Pick<
  Repo,
  'id' | 'badgeColor' | 'repoIcon' | 'addedAt' | 'executionHostId' | 'connectionId' | 'displayName'
>

export function selectDefaultProjectBadgeStyle(state: {
  settings?: Pick<GlobalSettings, 'defaultProjectBadgeStyle'> | null
}): DefaultProjectBadgeStyle {
  return state.settings?.defaultProjectBadgeStyle === 'folder' ? 'folder' : 'letters'
}

// Every card asks for its mark; resolve the catalog once per repos snapshot and fallback style.
const appearancesByRepos = new WeakMap<
  readonly Repo[],
  Partial<Record<DefaultProjectBadgeStyle, Map<string, RepoMarkAppearance>>>
>()

function appearancesFor(
  repos: readonly Repo[],
  defaultStyle: DefaultProjectBadgeStyle
): Map<string, RepoMarkAppearance> {
  let byStyle = appearancesByRepos.get(repos)
  if (!byStyle) {
    byStyle = {}
    appearancesByRepos.set(repos, byStyle)
  }
  let appearances = byStyle[defaultStyle]
  if (!appearances) {
    appearances = resolveRepoMarkAppearances(repos, { defaultStyle })
    byStyle[defaultStyle] = appearances
  }
  return appearances
}

export function useRepoMarkAppearance(repo: RepoMarkRepo): RepoMarkAppearance {
  const repos = useAppStore((state) => state.repos)
  const defaultStyle = useAppStore(selectDefaultProjectBadgeStyle)
  return (
    appearancesFor(repos, defaultStyle).get(repoMarkKey(repo)) ??
    // A repo not in the catalog yet (e.g. mid-add) resolves on its own.
    resolveRepoMarkAppearances([repo], { defaultStyle }).get(repoMarkKey(repo)) ?? {
      icon:
        repo.repoIcon ??
        (defaultStyle === 'folder'
          ? { type: 'lucide', name: 'Folder' }
          : { type: 'letters', text: '?' }),
      color: resolveRepoBadgeColor(repo.badgeColor)
    }
  )
}

/** What Auto would pick for this project right now, so the Auto swatch can preview it. */
export function useRepoAutoMarkColor(repo: RepoMarkRepo): string {
  const repos = useAppStore((state) => state.repos)
  const defaultStyle = useAppStore(selectDefaultProjectBadgeStyle)
  const key = repoMarkKey(repo)
  return React.useMemo(() => {
    const asAuto = repos.map((candidate) =>
      repoMarkKey(candidate) === key
        ? { ...candidate, badgeColor: DEFAULT_REPO_BADGE_COLOR }
        : candidate
    )
    return (
      resolveRepoMarkAppearances(asAuto, { defaultStyle }).get(key)?.color ??
      DEFAULT_REPO_BADGE_COLOR
    )
  }, [repos, defaultStyle, key])
}

// Why: icons and emoji sit on a faint fill with a hairline edge so they read as a mark like letters do.
const GLYPH_FILL_PERCENT = 16
const GLYPH_BORDER_PERCENT = 25

function glyphTileStyle(color: string): React.CSSProperties {
  // Neutral has no hue to tint with, so it borrows the foreground at half strength.
  const base = color === DEFAULT_REPO_BADGE_COLOR ? 'var(--foreground)' : color
  const fill = color === DEFAULT_REPO_BADGE_COLOR ? GLYPH_FILL_PERCENT / 2 : GLYPH_FILL_PERCENT
  return {
    backgroundColor: `color-mix(in srgb, ${base} ${fill}%, transparent)`,
    boxShadow: `inset 0 0 0 0.5px color-mix(in srgb, ${base} ${GLYPH_BORDER_PERCENT}%, transparent)`
  }
}

const MARK_SIZES = {
  // Why: emoji glyphs scale with font size (0.9em), so the text size pins them to the icon box.
  sm: { box: 'size-4 rounded-[4px] text-xs', icon: 'size-3.5' },
  md: { box: 'size-4 rounded-[4px] text-xs', icon: 'size-3.5' }
} as const

export function RepoMarkView({
  appearance,
  size = 'sm',
  className
}: {
  appearance: RepoMarkAppearance
  size?: keyof typeof MARK_SIZES
  className?: string
}): React.JSX.Element {
  const sizes = MARK_SIZES[size]
  const repoIcon = appearance.icon
  const neutral = appearance.color === DEFAULT_REPO_BADGE_COLOR
  // Letters and pictures fill the mark; icons and emoji sit inset on a tile.
  const fills = repoIcon.type === 'letters' || repoIcon.type === 'image'
  const glyphSize = fills ? 'size-full' : sizes.icon
  return (
    <span
      aria-hidden="true"
      className={cn(
        'inline-flex shrink-0 items-center justify-center overflow-hidden',
        !fills && neutral && 'text-muted-foreground',
        sizes.box,
        className
      )}
      style={fills ? undefined : glyphTileStyle(appearance.color)}
    >
      <RepoIconGlyph
        repoIcon={repoIcon}
        color={repoIcon.type === 'letters' || !neutral ? appearance.color : undefined}
        className={glyphSize}
        iconClassName={glyphSize}
      />
    </span>
  )
}

/** The card-header mark: one tile shape for lucide, emoji and avatar icons alike. */
export function RepoMarkTile({
  appearance,
  className
}: {
  appearance: RepoMarkAppearance
  className?: string
}): React.JSX.Element {
  const repoIcon = appearance.icon
  const neutral = appearance.color === DEFAULT_REPO_BADGE_COLOR
  const image = repoIcon.type === 'image'
  const letters = repoIcon.type === 'letters'
  return (
    <span
      aria-hidden="true"
      className={cn(
        'inline-flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-[10px] text-[22px]',
        // Images fill the tile edge to edge; a hairline keeps dark avatars off the dark card.
        image && 'ring-1 ring-border ring-inset',
        className
      )}
      // Letters and pictures carry their own colors; icons and emoji sit on a faint tile.
      style={letters || image ? undefined : glyphTileStyle(appearance.color)}
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
  return <RepoMarkView appearance={appearance} size={size} className={className} />
}
