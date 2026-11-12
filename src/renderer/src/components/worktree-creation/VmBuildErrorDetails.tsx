import React from 'react'
import { Check, ChevronRight, Copy } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'

/** Raw error lines shown; earlier ones are left to Copy. */
export const ERROR_DETAILS_VISIBLE_LINES = 20

/** Keeps the last lines, since recipes and their tools usually print the cause at the end. */
export function truncateErrorDetails(text: string): { visible: string; hiddenLines: number } {
  const lines = text.split('\n')
  const hiddenLines = Math.max(0, lines.length - ERROR_DETAILS_VISIBLE_LINES)
  return {
    visible: hiddenLines > 0 ? lines.slice(hiddenLines).join('\n') : text,
    hiddenLines
  }
}

/**
 * Collapsed raw error from a user-authored recipe, under the card's plain-language summary.
 * Copy always takes the full text, even when the visible text is cut short.
 */
export function VmBuildErrorDetails({ text }: { text: string }): React.JSX.Element {
  const t = useTranslate()
  const [open, setOpen] = React.useState(false)
  const [copied, setCopied] = React.useState(false)
  const { visible, hiddenLines } = React.useMemo(() => truncateErrorDetails(text), [text])

  const scrollToEnd = React.useCallback((node: HTMLPreElement | null): void => {
    if (node) {
      node.scrollTop = node.scrollHeight
    }
  }, [])

  React.useEffect(() => {
    if (!copied) {
      return
    }
    const timer = window.setTimeout(() => setCopied(false), 1500)
    return () => window.clearTimeout(timer)
  }, [copied])

  const copy = (): void => {
    void window.api.ui
      .writeClipboardText(text)
      .then(() => setCopied(true))
      .catch(() => {
        toast.error(
          t(
            'auto.components.worktree.creation.VmBuildErrorDetails.copyFailed',
            'Couldn’t copy the details.'
          )
        )
      })
  }

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="flex flex-col">
      <CollapsibleTrigger asChild>
        <Button
          type="button"
          variant="quiet"
          size="xs"
          // Pulled left by its padding so the chevron lines up with the summary text above.
          className="-ms-1.5 w-fit"
        >
          <ChevronRight
            className={cn(
              'transition-transform motion-reduce:transition-none',
              open && 'rotate-90'
            )}
            aria-hidden
          />
          {t('auto.components.worktree.creation.VmBuildErrorDetails.toggle', 'Details')}
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent animation="height">
        <div className="flex flex-col gap-1.5 pt-1.5">
          {hiddenLines > 0 ? (
            <span className="text-xs text-muted-foreground">
              {t(
                'auto.components.worktree.creation.VmBuildErrorDetails.earlierLines',
                '…{{count}} earlier lines. Copy details includes them.',
                {
                  count: hiddenLines,
                  defaultValue_one: '…{{count}} earlier line. Copy details includes it.'
                }
              )}
            </span>
          ) : null}
          {/* Capped and scrollable too, so one very long wrapped line can't bury the actions. */}
          <pre
            // Starts scrolled to the end, where the cause usually is, like the visible window.
            ref={scrollToEnd}
            data-testid="vm-build-error-details-text"
            tabIndex={0}
            className="scrollbar-sleek max-h-80 max-w-full overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/40 px-3 py-2 font-mono text-xs leading-5 text-muted-foreground outline-none focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
          >
            {visible}
          </pre>
          <div className="flex items-center justify-end">
            <Button type="button" variant="ghost" size="xs" onClick={copy}>
              {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
              {copied
                ? t('auto.components.worktree.creation.VmBuildErrorDetails.copied', 'Copied')
                : t('auto.components.worktree.creation.VmBuildErrorDetails.copy', 'Copy details')}
            </Button>
            <span className="sr-only" aria-live="polite">
              {copied
                ? t(
                    'auto.components.worktree.creation.VmBuildErrorDetails.copiedStatus',
                    'Details copied'
                  )
                : ''}
            </span>
          </div>
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}
