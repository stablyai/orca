export function RoomPanelSection({
  title,
  action,
  children
}: {
  title: string
  action?: React.ReactNode
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {title}
        </h3>
        {action}
      </div>
      {children}
    </section>
  )
}

export function RoomPanelEmpty({
  label = 'Nothing here yet'
}: {
  label?: string
}): React.JSX.Element {
  return <p className="py-4 text-center text-xs text-muted-foreground">{label}</p>
}
