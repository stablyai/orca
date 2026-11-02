import { CircleAlert, Info, TriangleAlert } from 'lucide-react'

/** A persistent notice on a plugin's page; errors stay here until acted on. */
export function PluginDetailAlert({
  tone,
  title,
  body,
  action
}: {
  tone: 'info' | 'warning' | 'destructive'
  title: string
  body: string
  action?: React.ReactNode
}): React.JSX.Element {
  const Icon = tone === 'info' ? Info : tone === 'warning' ? TriangleAlert : CircleAlert
  return (
    <div
      role="status"
      data-tone={tone}
      className="mt-5 flex items-start gap-2.5 rounded-xl border border-border bg-muted/40 px-3.5 py-3 text-sm data-[tone=destructive]:border-destructive/35 data-[tone=destructive]:bg-destructive/7 data-[tone=warning]:border-status-warning/45 data-[tone=warning]:bg-status-warning/7"
    >
      <Icon
        aria-hidden="true"
        data-tone={tone}
        className="mt-0.5 size-4 shrink-0 data-[tone=destructive]:text-destructive data-[tone=warning]:text-status-warning-text"
      />
      <div className="min-w-0 flex-1">
        <p data-tone={tone} className="font-medium data-[tone=destructive]:text-destructive">
          {title}
        </p>
        <p className="mt-0.5 text-xs text-muted-foreground">{body}</p>
      </div>
      {action ? <div className="-my-1 shrink-0">{action}</div> : null}
    </div>
  )
}
