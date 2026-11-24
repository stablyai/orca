import { getRepoExecutionHostId } from '../../execution-host/execution-host'
import type { Repo } from '../repo-types'
import type { RepoIcon } from './repo-icon'
import { suggestRepoMonogram } from './repo-monogram'
import { DEFAULT_REPO_BADGE_COLOR, REPO_COLORS, normalizeRepoBadgeColor } from './repo-badge-color'

export type RepoMarkAppearance = {
  /** What the mark shows: the chosen icon, or default letters when none is set. */
  icon: RepoIcon
  /** Tint for lucide glyphs and the fill behind letters; images and emoji keep their own colors. */
  color: string
}

type RepoMarkInput = Pick<Repo, 'id' | 'badgeColor' | 'repoIcon' | 'addedAt' | 'displayName'> & {
  executionHostId?: Repo['executionHostId']
  connectionId?: Repo['connectionId']
}

// Same-ID repos can live on several hosts, so the host is part of the identity.
export function repoMarkKey(
  repo: Pick<RepoMarkInput, 'id' | 'executionHostId' | 'connectionId'>
): string {
  return `${getRepoExecutionHostId(repo)}\0${repo.id}`
}

const LETTERS_GROUP = '\0letters'

function glyphKey(icon: RepoIcon): string | null {
  // Images and emoji render in their own colors, so only tintable glyphs join a color group.
  if (icon?.type === 'image' || icon?.type === 'emoji') {
    return null
  }
  // Every monogram is a solid color tile, so all of them share one color group.
  if (icon?.type === 'letters') {
    return LETTERS_GROUP
  }
  return icon.name
}

type MarkEntry = { repo: RepoMarkInput; icon: RepoIcon }

/**
 * Projects without a chosen icon show letters from their name, kept distinct from the letters
 * other projects show. Oldest first, so adding a project never relabels ones the user knows.
 */
function withDefaultIcons(ordered: readonly RepoMarkInput[]): MarkEntry[] {
  const taken = new Set<string>()
  for (const repo of ordered) {
    if (repo.repoIcon?.type === 'letters') {
      taken.add(repo.repoIcon.text.toUpperCase())
    }
  }
  return ordered.map((repo) => {
    if (repo.repoIcon) {
      return { repo, icon: repo.repoIcon }
    }
    const text = suggestRepoMonogram(repo.displayName, taken)
    taken.add(text)
    return { repo, icon: { type: 'letters', text } }
  })
}

/** Neutral is the stored default, so it means "pick for me" rather than an explicit choice. */
export function explicitRepoMarkColor(badgeColor: unknown): string | null {
  const normalized = normalizeRepoBadgeColor(badgeColor)
  return normalized && normalized !== DEFAULT_REPO_BADGE_COLOR ? normalized : null
}

/**
 * Resolve each project's mark so projects sharing a glyph stay tellable apart:
 * auto-colored members of a glyph group take palette colors the group isn't using yet.
 */
export function resolveRepoMarkAppearances(
  repos: readonly RepoMarkInput[]
): Map<string, RepoMarkAppearance> {
  const groups = new Map<string, MarkEntry[]>()
  const result = new Map<string, RepoMarkAppearance>()
  // Oldest first so adding a project never recolors the ones the user already knows.
  const ordered = [...repos].sort((a, b) => a.addedAt - b.addedAt || a.id.localeCompare(b.id))
  for (const entry of withDefaultIcons(ordered)) {
    const key = glyphKey(entry.icon)
    if (key === null) {
      result.set(repoMarkKey(entry.repo), {
        icon: entry.icon,
        color: explicitRepoMarkColor(entry.repo.badgeColor) ?? DEFAULT_REPO_BADGE_COLOR
      })
      continue
    }
    groups.set(key, [...(groups.get(key) ?? []), entry])
  }

  for (const members of groups.values()) {
    const used = new Set(members.map(({ repo }) => explicitRepoMarkColor(repo.badgeColor)))
    // Grey reads as "no color picked", so Auto always lands on a real color.
    const palette = REPO_COLORS.filter(
      (color) => !used.has(color) && color !== DEFAULT_REPO_BADGE_COLOR
    )
    let next = 0
    for (const { repo, icon } of members) {
      const color =
        explicitRepoMarkColor(repo.badgeColor) ??
        (palette.length > 0 ? palette[next++ % palette.length] : DEFAULT_REPO_BADGE_COLOR)
      result.set(repoMarkKey(repo), { icon, color })
    }
  }
  return result
}
