type StatCardProps = {
  label: string
  value: string
  icon: React.ReactNode
  detail?: string
}

export function StatCard({ label, value, icon, detail }: StatCardProps): React.JSX.Element {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-border/50 bg-card/60 px-4 py-3">
      <div className="flex size-9 shrink-0 items-center justify-center rounded-md bg-muted/60 text-muted-foreground">
        {icon}
      </div>
      <div className="min-w-0">
        <p className="text-lg font-semibold leading-tight text-foreground">{value}</p>
        <p className="text-xs text-muted-foreground">
          {label}
          {detail ? ` · ${detail}` : ''}
        </p>
      </div>
    </div>
  )
}
