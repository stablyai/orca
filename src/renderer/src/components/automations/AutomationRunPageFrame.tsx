import React from 'react'
import { ArrowLeft } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'

type AutomationRunPageFrameProps = {
  title: string
  breadcrumbs: string[]
  status: React.ReactNode
  detail?: string | null
  actions?: React.ReactNode
  children: React.ReactNode
  onBack: () => void
}

export function AutomationRunPageFrame({
  title,
  breadcrumbs,
  status,
  detail,
  actions,
  children,
  onBack
}: AutomationRunPageFrameProps): React.JSX.Element {
  return (
    // A document page, not a card: one centered column so sections read by spacing, not borders.
    <div className="scrollbar-sleek min-h-0 w-full flex-1 overflow-auto">
      <div className="mx-auto w-full max-w-[880px] px-6 pb-10">
        <div className="flex items-start justify-between gap-3 border-b border-border/50 py-4">
          <div className="flex min-w-0 flex-1 items-start gap-2">
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              className="mt-0.5 shrink-0"
              aria-label={translate(
                'auto.components.automations.AutomationRunPageFrame.33741dd973',
                'Back to runs'
              )}
              onClick={onBack}
            >
              <ArrowLeft className="size-3.5" />
            </Button>
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <h1
                  className="min-w-0 truncate text-lg font-semibold text-foreground"
                  aria-current="page"
                >
                  {title}
                </h1>
                {status}
              </div>
              {breadcrumbs.length > 0 ? (
                <ol
                  aria-label={translate(
                    'auto.components.automations.AutomationRunPageFrame.40a511bed4',
                    'Run context'
                  )}
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
                <div className="mt-1 truncate font-mono text-2xs text-muted-foreground/80">
                  {detail}
                </div>
              ) : null}
            </div>
          </div>
          {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
        </div>
        <div className="space-y-8 pt-6">{children}</div>
      </div>
    </div>
  )
}
