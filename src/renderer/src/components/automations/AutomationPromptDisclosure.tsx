import React, { useCallback, useEffect, useId, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'

export function AutomationPromptDisclosure({ prompt }: { prompt: string }): React.JSX.Element {
  const contentId = useId()
  const expandedRef = useRef(false)
  const toggleRef = useRef<HTMLButtonElement>(null)
  const [promptElement, setPromptElement] = useState<HTMLParagraphElement | null>(null)
  const [expanded, setExpanded] = useState(false)
  const [overflows, setOverflows] = useState(false)

  const measureOverflow = useCallback((element: HTMLParagraphElement) => {
    const nextOverflows = element.scrollHeight > element.clientHeight + 1
    if (!nextOverflows && document.activeElement === toggleRef.current) {
      element.focus({ preventScroll: true })
    }
    setOverflows((current) => (current === nextOverflows ? current : nextOverflows))
  }, [])

  useEffect(() => {
    if (!promptElement || expanded) {
      return
    }

    const updateOverflow = () => {
      if (!expandedRef.current) {
        measureOverflow(promptElement)
      }
    }
    updateOverflow()
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', updateOverflow)
      return () => window.removeEventListener('resize', updateOverflow)
    }

    const observer = new ResizeObserver(updateOverflow)
    observer.observe(promptElement)
    return () => observer.disconnect()
  }, [expanded, measureOverflow, promptElement])

  const toggleExpanded = (): void => {
    const nextExpanded = !expanded
    expandedRef.current = nextExpanded
    setExpanded(nextExpanded)
  }

  return (
    <div className="rounded-md border border-border/50 bg-muted/20 shadow-sm">
      <div className="flex items-center justify-between gap-3 border-b border-border/50 px-3 py-2">
        <div className="text-sm font-medium">
          {translate('auto.components.automations.AutomationEditorDialog.058c23cb3f', 'Prompt')}
        </div>
        {overflows || expanded ? (
          <Button
            ref={toggleRef}
            type="button"
            variant="ghost"
            size="xs"
            className="-mr-2 text-muted-foreground hover:text-foreground"
            aria-expanded={expanded}
            aria-controls={contentId}
            onClick={toggleExpanded}
          >
            {expanded
              ? translate(
                  'auto.components.automations.AutomationPromptDisclosure.showLess',
                  'Show less'
                )
              : translate(
                  'auto.components.automations.AutomationPromptDisclosure.showMore',
                  'Show more'
                )}
          </Button>
        ) : null}
      </div>
      <div className="min-w-0 px-3 py-3">
        <p
          ref={setPromptElement}
          id={contentId}
          tabIndex={-1}
          className={cn(
            'select-text whitespace-pre-wrap text-sm text-foreground [overflow-wrap:anywhere]',
            !expanded && 'line-clamp-4'
          )}
        >
          {prompt}
        </p>
      </div>
    </div>
  )
}
