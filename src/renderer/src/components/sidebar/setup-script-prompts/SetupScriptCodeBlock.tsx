import React, { useId, useMemo, useRef, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/class-names'
import { useTranslate } from '@/i18n/use-translate'
import { countScriptLines } from '@/components/script-editor/rows/script-textarea-rows'

export const SETUP_SCRIPT_COLLAPSED_LINES = 5
const LINE_HEIGHT_PX = 20
// py-1.5 plus room for a horizontal scrollbar, so the last line is never clipped.
const BLOCK_PADDING_PX = 20

export function SetupScriptCodeBlock({
  heading,
  script
}: {
  heading: string
  script: string
}): React.JSX.Element {
  const t = useTranslate()
  const contentId = useId()
  const lineCount = useMemo(() => countScriptLines(script), [script])
  const collapsible = lineCount > SETUP_SCRIPT_COLLAPSED_LINES
  const [expanded, setExpanded] = useState(false)
  const collapsed = collapsible && !expanded
  const preRef = useRef<HTMLPreElement>(null)

  const toggleExpanded = (): void => {
    if (expanded && preRef.current) {
      // Collapsing keeps the scroll offset, so reset it to show the script's first lines.
      preRef.current.scrollTop = 0
    }
    setExpanded(!expanded)
  }

  return (
    <section className="min-w-0 shrink-0 overflow-hidden rounded-md border border-border/70 bg-muted/35">
      <h3 className="px-3 pt-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {heading}
      </h3>
      <div className="relative">
        {/* An exact target height keeps the max-height transition in step with the content; long scripts scroll inside 40vh so two blocks still fit. */}
        <pre
          ref={preRef}
          id={contentId}
          tabIndex={collapsed ? -1 : 0}
          aria-label={heading}
          style={{
            maxHeight: collapsed
              ? `${SETUP_SCRIPT_COLLAPSED_LINES * LINE_HEIGHT_PX + BLOCK_PADDING_PX}px`
              : `min(${lineCount * LINE_HEIGHT_PX + BLOCK_PADDING_PX}px, 40vh)`
          }}
          className={cn(
            'overflow-x-auto px-3 py-1.5 font-mono text-xs leading-5 whitespace-pre text-foreground outline-none transition-[max-height] duration-200 ease-out motion-reduce:transition-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring',
            collapsed ? 'overflow-y-hidden scrollbar-sleek' : 'overflow-y-auto scrollbar-sleek'
          )}
        >
          {script}
        </pre>
        {collapsed ? (
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-0 bottom-0 h-8 bg-gradient-to-t from-muted/80 to-transparent"
          />
        ) : null}
      </div>
      {collapsible ? (
        <div className="border-t border-border/70 px-1 py-0.5">
          <Button
            type="button"
            variant="ghost"
            size="xs"
            aria-expanded={expanded}
            aria-controls={contentId}
            onClick={toggleExpanded}
          >
            <ChevronDown
              className={cn(
                'size-3.5 transition-transform duration-200 motion-reduce:transition-none',
                expanded && 'rotate-180'
              )}
            />
            {expanded
              ? t('auto.components.sidebar.SetupScriptCodeBlock.showLess', 'Show less')
              : t(
                  'auto.components.sidebar.SetupScriptCodeBlock.showMore',
                  'Show {{count}} more lines',
                  {
                    count: lineCount - SETUP_SCRIPT_COLLAPSED_LINES,
                    defaultValue_one: 'Show {{count}} more line'
                  }
                )}
          </Button>
        </div>
      ) : null}
    </section>
  )
}
