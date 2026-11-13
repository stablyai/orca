// Small layout pieces shared by the single sign-on and directory sync groups.
import type { LucideIcon } from 'lucide-react'

/** A group title with its section icon in front, so the two blocks read as siblings. */
export function GroupTitle({
  icon: Icon,
  children
}: {
  icon: LucideIcon
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <span className="inline-flex items-center gap-2">
      <Icon aria-hidden="true" className="size-4 text-muted-foreground" />
      {children}
    </span>
  )
}

/** One settings row: a title and a line of body text, with an optional control on the right. */
export function Row({
  title,
  body,
  children
}: {
  title: React.ReactNode
  body: React.ReactNode
  children?: React.ReactNode
}): React.JSX.Element {
  return (
    <div data-settings-row="" className="flex flex-wrap items-center gap-3 py-4">
      <div className="min-w-[14rem] flex-1 space-y-0.5">
        <p className="flex flex-wrap items-center gap-2 text-sm font-medium">{title}</p>
        <p className="text-xs text-muted-foreground text-pretty">{body}</p>
      </div>
      {children}
    </div>
  )
}
