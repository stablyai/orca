import type { ReactNode } from 'react'
import { cn } from '@/lib/class-names'

/** The agent field's closed face: an icon, the label and its muted detail. `muted` reads the label as
 *  a placeholder, for a choice that names no agent. */
export function AgentLaunchPickerTriggerLabel({
  icon,
  label,
  detail,
  muted
}: {
  icon: ReactNode
  label: string
  detail?: string
  muted?: boolean
}) {
  return (
    <>
      {icon}
      <span className={cn('min-w-0 flex-1 truncate text-left', muted && 'text-muted-foreground')}>
        {label}
        {detail ? <span className="text-muted-foreground"> · {detail}</span> : null}
      </span>
    </>
  )
}
