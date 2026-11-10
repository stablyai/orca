import React from 'react'
import { useTranslate } from '@/i18n/use-translate'
import { Skeleton } from '@/components/ui/skeleton'

/** The section frame the panel shell uses: numbered h3, help line, then rows. */
export function PanelSection({
  number,
  title,
  help,
  children,
  footer
}: {
  number?: React.ReactNode
  title: string
  help?: string
  children: React.ReactNode
  footer?: React.ReactNode
}): React.JSX.Element {
  const id = React.useId()
  return (
    <section aria-labelledby={id} className="flex flex-col gap-3 px-5 py-4">
      <div className="flex flex-col gap-1">
        <h3 id={id} className="flex items-baseline gap-2 text-sm font-medium text-foreground">
          {number !== undefined ? (
            <span aria-hidden className="text-muted-foreground tabular-nums">
              {number}
            </span>
          ) : null}
          {title}
        </h3>
        {help ? <p className="text-xs leading-5 text-muted-foreground">{help}</p> : null}
      </div>
      {children}
      {footer}
    </section>
  )
}

export function LoadingRows(): React.JSX.Element {
  const t = useTranslate()
  return (
    <div aria-busy="true" className="flex flex-col gap-3">
      {[0, 1].map((row) => (
        <div key={row} className="flex items-center gap-3">
          <Skeleton shape="small" className="h-3 w-16" />
          <Skeleton shape="small" className="h-3 w-44" />
          <Skeleton shape="small" className="ms-auto h-3 w-10" />
        </div>
      ))}
      <span className="sr-only">
        {t('agentHostPanel.loadingSecrets', 'Loading Cloud secrets…')}
      </span>
    </div>
  )
}
