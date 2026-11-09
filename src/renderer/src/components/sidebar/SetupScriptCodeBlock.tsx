import React, { useId, useMemo, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useTranslate } from '@/i18n/use-translate'

export const SETUP_SCRIPT_COLLAPSED_LINES = 5
const LINE_HEIGHT_PX = 20
// py-1.5 plus room for a horizontal scrollbar, so the last line is never clipped.
const BLOCK_PADDING_PX = 20

function countLines(script: string): number {
  let lines = 1
  for (let index = 0; index < script.length; index += 1) {
    if (script.charCodeAt(index) === 10) {
      lines += 1
    }
  }
  return lines
}

export function SetupScriptCodeBlock({
  heading,
  script
}: {
  heading: string
  script: string
}): React.JSX.Element {
  const t = useTranslate()
  const contentId = useId()
  const lineCount = useMemo(() => countLines(script), [script])
  const collapsible = lineCount > SETUP_SCRIPT_COLLAPSED_LINES
  const [expanded, setExpanded] = useState(false)
  const collapsed = collapsible && !expanded

  return (
    <section className="min-w-0 overflow-hidden rounded-md border border-border/70 bg-muted/35">
      <h3 className="px-3 pt-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {heading}
      </h3>
      <div className="relative">
        {/* An exact target height keeps the max-height transition in step with the content; long scripts scroll inside 50vh. */}
        <pre
          id={contentId}
          tabIndex={0}
          aria-label={heading}
          data-collapsed={collapsed ? 'true' : 'false'}
          style={{
            maxHeight: collapsed
              ? `${SETUP_SCRIPT_COLLAPSED_LINES * LINE_HEIGHT_PX + BLOCK_PADDING_PX}px`
              : `min(${lineCount * LINE_HEIGHT_PX + BLOCK_PADDING_PX}px, 50vh)`
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
            className="text-muted-foreground"
            onClick={() => setExpanded((value) => !value)}
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
