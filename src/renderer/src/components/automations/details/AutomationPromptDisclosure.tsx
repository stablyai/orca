import React, { useCallback, useEffect, useId, useRef, useState } from 'react'
import { Check, ChevronDown, Copy } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/class-names'
import { useTranslate } from '@/i18n/use-translate'
import { useClipboardTextCopyFeedback } from '@/hooks/clipboard/use-clipboard-text-copy-feedback'
import { AUTOMATION_EDITOR_SECTION_LABEL_CLASS } from '../automation-page-parts'

export function AutomationPromptDisclosure({ prompt }: { prompt: string }): React.JSX.Element {
  const t = useTranslate()
  const contentId = useId()
  const expandedRef = useRef(false)
  const toggleRef = useRef<HTMLButtonElement>(null)
  const [promptElement, setPromptElement] = useState<HTMLParagraphElement | null>(null)
  const [expanded, setExpanded] = useState(false)
  const [overflows, setOverflows] = useState(false)
  const { canCopy, copyText, status: copyStatus } = useClipboardTextCopyFeedback(prompt)
  const copyLabel =
    copyStatus === 'copied'
      ? t('auto.components.automations.AutomationPromptDisclosure.copied', 'Copied')
      : copyStatus === 'failed'
        ? t('auto.components.automations.AutomationPromptDisclosure.copyFailed', 'Copy failed')
        : t('auto.components.automations.AutomationPromptDisclosure.copyPrompt', 'Copy prompt')

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
    <section className="min-w-0 rounded-lg border border-border/60">
      <div className="flex items-center justify-between gap-3 border-b border-border/60 py-1.5 pr-2 pl-4">
        <h3 className={`text-muted-foreground ${AUTOMATION_EDITOR_SECTION_LABEL_CLASS}`}>
          {t('auto.components.automations.AutomationEditorDialog.058c23cb3f', 'Prompt')}
        </h3>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={copyLabel}
              disabled={!canCopy}
              onClick={() => void copyText()}
            >
              {copyStatus === 'copied' ? <Check /> : <Copy />}
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top" sideOffset={4}>
            {copyLabel}
          </TooltipContent>
        </Tooltip>
      </div>
      <div className="relative min-w-0 px-4 py-3">
        <p
          ref={setPromptElement}
          id={contentId}
          tabIndex={-1}
          className={cn(
            'max-w-[80ch] select-text whitespace-pre-wrap text-sm leading-relaxed text-foreground [overflow-wrap:anywhere] focus-visible:outline-none',
            !expanded && 'line-clamp-8'
          )}
        >
          {prompt}
        </p>
        {overflows && !expanded ? (
          <div
            className="pointer-events-none absolute inset-x-0 bottom-3 h-10 bg-gradient-to-t from-background to-transparent"
            aria-hidden="true"
          />
        ) : null}
      </div>
      {overflows || expanded ? (
        <div className="border-t border-border/60 px-2 py-1">
          <Button
            ref={toggleRef}
            type="button"
            variant="ghost"
            size="xs"
            aria-expanded={expanded}
            aria-controls={contentId}
            onClick={toggleExpanded}
          >
            <ChevronDown
              className={cn(
                'transition-transform motion-reduce:transition-none',
                expanded && 'rotate-180'
              )}
            />
            {expanded
              ? t('auto.components.automations.AutomationPromptDisclosure.showLess', 'Show less')
              : t('auto.components.automations.AutomationPromptDisclosure.showMore', 'Show more')}
          </Button>
        </div>
      ) : null}
    </section>
  )
}
