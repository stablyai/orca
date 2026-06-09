import React from 'react'
import { ArrowLeft } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'

type AutomationRunPageFrameProps = {
  title: string
  breadcrumbs: string[]
  statusLabel: string
  statusVariant: React.ComponentProps<typeof Badge>['variant']
  detail?: string | null
  actions?: React.ReactNode
  children: React.ReactNode
  onBack: () => void
}

export function AutomationRunPageFrame({
  title,
  breadcrumbs,
  statusLabel,
  statusVariant,
  detail,
  actions,
  children,
  onBack
}: AutomationRunPageFrameProps): React.JSX.Element {
  return (
    <div className="flex min-h-full flex-col rounded-md border border-border/50 bg-background shadow-sm">
      <div className="flex shrink-0 items-start justify-between gap-3 border-b border-border/50 px-4 py-3">
        <div className="flex min-w-0 flex-1 items-start gap-2">
          <div className="shrink-0">
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={translate("auto.components.automations.AutomationRunPageFrame.33741dd973", "Back to runs")}
              onClick={onBack}
            >
              <ArrowLeft className="size-3.5" />
            </Button>
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-semibold text-foreground" aria-current="page">
              {title}
            </div>
            {breadcrumbs.length > 0 ? (
              <ol
                aria-label={translate("auto.components.automations.AutomationRunPageFrame.40a511bed4", "Run context")}
                className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-muted-foreground"
              >
                {breadcrumbs.map((breadcrumb, index) => (
                  <React.Fragment key={`${breadcrumb}:${index}`}>
                    {index > 0 ? (
                      <li aria-hidden="true" className="shrink-0 opacity-50">
                        ·
                      </li>
                    ) : null}
                    <li className="max-w-[28ch] truncate">{breadcrumb}</li>
                  </React.Fragment>
                ))}
              </ol>
            ) : null}
            {detail ? (
              <div className="mt-1 truncate font-mono text-[11px] text-muted-foreground/80">
                {detail}
              </div>
            ) : null}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Badge variant={statusVariant}>{statusLabel}</Badge>
          {actions}
        </div>
      </div>
      <div className="scrollbar-sleek min-h-0 flex-1 overflow-auto p-4">{children}</div>
    </div>
  )
}
