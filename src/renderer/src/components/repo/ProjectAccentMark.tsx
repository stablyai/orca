import type { CSSProperties } from 'react'
import { DEFAULT_REPO_BADGE_COLOR } from '../../../../shared/constants'
import { normalizeRepoBadgeColor } from '../../../../shared/repo-badge-color'

export function ProjectAccentMark({ color }: { color?: string | null }) {
  const accent = normalizeRepoBadgeColor(color)
  if (!accent || accent === DEFAULT_REPO_BADGE_COLOR) {
    return null
  }
  return (
    <span
      aria-hidden="true"
      data-project-accent={accent}
      className="project-accent-mark shrink-0"
      style={{ '--project-accent-source': accent } as CSSProperties}
    />
  )
}
