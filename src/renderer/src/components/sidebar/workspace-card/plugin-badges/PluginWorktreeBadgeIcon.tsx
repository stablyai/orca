import { createElement } from 'react'
import type React from 'react'
import { Puzzle } from 'lucide-react'
import { resolvePluginIconGlyph } from '@/components/plugins/plugin-icon-glyphs'
import { cn } from '@/lib/class-names'
import type { PluginWorktreeBadgeIcon as BadgeIcon } from '../../../../../../shared/plugins/contributions/plugin-worktree-badge-contribution'

/** Named icons come from the panel icon set; a plugin SVG is a mask, so it takes the text color in
 *  every theme and can never run script or load anything. */
export function PluginWorktreeBadgeIcon({
  icon,
  className
}: {
  icon: BadgeIcon
  className?: string
}): React.JSX.Element {
  if (icon.kind === 'named') {
    // Why createElement: the glyph map holds stable module-level components.
    return createElement(resolvePluginIconGlyph(icon.name, Puzzle), {
      className: cn('shrink-0', className)
    })
  }
  const mask = `url("data:image/svg+xml;charset=utf-8,${encodeURIComponent(icon.markup)}")`
  return (
    <span
      aria-hidden
      className={cn('inline-block shrink-0 bg-current', className)}
      style={{
        maskImage: mask,
        WebkitMaskImage: mask,
        maskSize: 'contain',
        WebkitMaskSize: 'contain',
        maskRepeat: 'no-repeat',
        WebkitMaskRepeat: 'no-repeat',
        maskPosition: 'center',
        WebkitMaskPosition: 'center'
      }}
    />
  )
}
