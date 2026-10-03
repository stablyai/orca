import type React from 'react'
import type { RepoIcon } from '../../../../shared/repo-icon'
import { resolveProjectIconDisplay } from '../../../../shared/default-project-icon'
import { useAppStore } from '@/store'
import { RepoIconGlyph } from './repo-icon'

/**
 * A project's glyph with the global default applied: projects carrying no icon of their own draw the
 * user's default icon instead of the GitHub owner avatar. Resolution stays here rather than in
 * `RepoIconGlyph` so the picker can still preview a specific icon.
 */
export function ProjectIconGlyph({
  repoIcon,
  className,
  iconClassName,
  color
}: {
  repoIcon: RepoIcon | null | undefined
  className?: string
  iconClassName?: string
  color?: string
}): React.JSX.Element {
  const defaultProjectIcon = useAppStore((state) => state.settings?.defaultProjectIcon)
  const defaultProjectIconColor = useAppStore((state) => state.settings?.defaultProjectIconColor)
  const display = resolveProjectIconDisplay(repoIcon, color, {
    defaultProjectIcon,
    defaultProjectIconColor
  })

  return (
    <RepoIconGlyph
      repoIcon={display.repoIcon}
      color={display.color ?? undefined}
      className={className}
      iconClassName={iconClassName}
    />
  )
}
