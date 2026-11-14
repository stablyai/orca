export function SectionHeader({
  title,
  count,
  children
}: {
  title: string
  count: number
  children?: React.ReactNode
}) {
  return (
    <div className="flex items-center gap-1 px-2 pt-3 pb-1">
      <span className="min-w-0 flex-1 truncate text-[11px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
        {title}
      </span>
      {children}
      <span className="text-[11px] text-muted-foreground">{count}</span>
    </div>
  )
}
