import React from 'react'
import { ExternalLink } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import type { PRCheckAnnotation } from '../../../../shared/types'
import {
  cancelAnnotationRevealFrame,
  getOpenableAnnotationLine,
  openAnnotationLocation
} from './check-annotation-open'

export function CheckRunAnnotations({
  annotations,
  worktreeId
}: {
  annotations: PRCheckAnnotation[]
  worktreeId: string | null
}): React.JSX.Element {
  const revealRafRef = React.useRef<number | null>(null)
  const revealInnerRafRef = React.useRef<number | null>(null)
  React.useEffect(
    () => () => {
      cancelAnnotationRevealFrame(revealRafRef)
      cancelAnnotationRevealFrame(revealInnerRafRef)
    },
    []
  )
  const openAnnotation = React.useCallback(
    (path: string, line: number) => {
      if (!worktreeId) {
        return
      }
      openAnnotationLocation({ worktreeId, path, line, revealRafRef, revealInnerRafRef })
    },
    [worktreeId]
  )

  return (
    <section className="rounded-md border border-border bg-background">
      <div className="border-b border-border px-3 py-2 text-sm font-medium">
        {translate('auto.components.editor.CheckRunDetailsPanel.f2fe8a4e8f', 'Annotations')}
      </div>
      <div className="divide-y divide-border/50">
        {annotations.map((annotation, index) => {
          const openable = worktreeId ? getOpenableAnnotationLine(annotation) : null
          const locationLabel = `${
            annotation.path ??
            translate('auto.components.editor.CheckRunDetailsPanel.cdbfda4dec', 'Annotation')
          }${annotation.startLine ? `:${annotation.startLine}` : ''}`
          return (
            <div key={`${annotation.path ?? 'annotation'}-${index}`} className="px-3 py-3">
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                {openable ? (
                  <button
                    type="button"
                    onClick={() => openAnnotation(openable.path, openable.line)}
                    title={translate(
                      'auto.components.editor.CheckRunDetailsPanel.5e2a9c3f88',
                      'Open file at this line'
                    )}
                    className="group inline-flex min-w-0 items-center gap-1 break-all rounded font-mono text-xs text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <span className="min-w-0 break-all text-left">{locationLabel}</span>
                    <ExternalLink className="size-3 shrink-0 opacity-70" />
                  </button>
                ) : (
                  <span className="min-w-0 break-all font-mono text-xs text-muted-foreground">
                    {locationLabel}
                  </span>
                )}
                {annotation.annotationLevel && (
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {annotation.annotationLevel}
                  </span>
                )}
              </div>
              {annotation.title && (
                <div className="mt-2 text-sm font-medium text-foreground">{annotation.title}</div>
              )}
              <div className="mt-2 break-words text-sm text-foreground">{annotation.message}</div>
              {annotation.rawDetails && (
                <pre className="mt-2 max-h-60 overflow-auto whitespace-pre-wrap rounded bg-muted/40 p-3 font-mono text-xs text-muted-foreground scrollbar-sleek">
                  {annotation.rawDetails}
                </pre>
              )}
            </div>
          )
        })}
      </div>
    </section>
  )
}
