import type { ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'
import { Badge } from '@/components/ui/badge'

export function NativeChatPromptPill({
  icon: Icon,
  avatar,
  label,
  spokenLabel,
  muted = false,
  selected,
  detail,
  trailing,
  ...badgeProps
}: {
  icon: LucideIcon
  /** Shown in place of the icon when there is a picture for what the pill names, as a bot's. */
  avatar?: ReactNode
  label: string
  /** What a screen reader says for the pill in place of what it shows, e.g. "Skill: Review". */
  spokenLabel?: ReactNode
  /** Dimmed and dashed: what it names can't be used now, as a deleted or paused bot. */
  muted?: boolean
  selected: boolean
  title?: string
  /** What the pill names inside its label's owner, after `›` (a bot's chat); only it is cut short. */
  detail?: ReactNode
  /** A control at the pill's end, such as a bot pill's ⌄. */
  trailing?: ReactNode
}): React.JSX.Element {
  // Hidden text, not aria-label: a plain span can't carry an accessible name.
  const hidden = spokenLabel ? true : undefined
  return (
    <Badge
      variant="promptPill"
      data-selected={selected}
      data-muted={muted || undefined}
      {...badgeProps}
    >
      {spokenLabel ? <span className="sr-only">{spokenLabel}</span> : null}
      {avatar ? (
        // Out of flow in an icon-sized box, so the pill sits on the baseline an icon pill does
        // whether the avatar is a picture or text (an emoji or initial); it overhangs by 1px.
        <span aria-hidden="true" className="relative mx-px size-3 shrink-0">
          <span className="absolute -inset-px flex">{avatar}</span>
        </span>
      ) : (
        <Icon aria-hidden="true" />
      )}
      <span aria-hidden={hidden} className={detail === undefined ? 'truncate' : 'shrink-0'}>
        {label}
      </span>
      {detail === undefined ? null : (
        <>
          <span aria-hidden className="shrink-0 opacity-70">
            ›
          </span>
          <span aria-hidden={hidden} className="min-w-0 truncate">
            {detail}
          </span>
        </>
      )}
      {trailing}
    </Badge>
  )
}
