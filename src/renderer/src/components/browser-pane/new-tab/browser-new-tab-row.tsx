import { ArrowUpRight } from 'lucide-react'

export function BrowserNewTabRow({
  icon,
  title,
  detail,
  trailing,
  onOpen
}: {
  icon: React.ReactNode
  title: string
  detail: React.ReactNode
  trailing?: React.ReactNode
  onOpen: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="group/row flex w-full min-w-0 items-center gap-3.5 rounded-xl px-3 py-2.5 text-left outline-none hover:bg-accent focus-visible:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
    >
      <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-muted group-hover/row:bg-background group-focus-visible/row:bg-background">
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm text-foreground">{title}</span>
        <span className="block truncate text-xs text-muted-foreground">{detail}</span>
      </span>
      {trailing ?? (
        <ArrowUpRight className="size-4 shrink-0 text-muted-foreground opacity-0 group-hover/row:opacity-100 group-focus-visible/row:opacity-100" />
      )}
    </button>
  )
}
