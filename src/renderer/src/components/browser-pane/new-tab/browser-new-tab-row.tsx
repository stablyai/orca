/** One row of the workspace card: an icon, a title over a detail line, and optional trailing state. */
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
      className="flex w-full min-w-0 items-center gap-3 rounded-lg px-2 py-1.5 text-left outline-none hover:bg-accent focus-visible:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
    >
      <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-muted">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm text-foreground">{title}</span>
        <span className="block truncate text-xs text-muted-foreground">{detail}</span>
      </span>
      {trailing}
    </button>
  )
}
