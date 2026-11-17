import type { AlertCircle } from 'lucide-react'

/** The Orca Cloud panes' empty and signed-out placeholder: an icon, a title, a line and an action. */
export function CloudEmptyState({
  icon: Icon,
  title,
  description,
  action
}: {
  icon: typeof AlertCircle
  title: string
  description: string
  action?: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="flex flex-col items-center gap-3 px-6 py-9 text-center">
      <div className="flex size-10 items-center justify-center rounded-full border border-border bg-muted/40 text-muted-foreground">
        <Icon className="size-[18px]" aria-hidden />
      </div>
      <div className="max-w-sm space-y-1">
        <p className="text-sm font-medium">{title}</p>
        <p className="text-xs leading-5 text-muted-foreground">{description}</p>
      </div>
      {action}
    </div>
  )
}
