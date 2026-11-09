import React from 'react'
import { ArrowDownToLine, Check, Copy } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useTranslate } from '@/i18n/use-translate'
import { toast } from 'sonner'
import { formatElapsedTime } from './worktree-creation-clock'

// `(?!-)` skips names such as "error-overlay"; errno codes (ENOENT) are matched case-sensitively.
const ERROR_WORD =
  /\b(error|errors|fatal|failed|failure|denied|refused|not found|exception|panic)\b(?!-)/i
const ERRNO = /^E[A-Z]{3,}\b/

/** Splits the log into display lines, dropping the empty line a trailing newline opens. */
export function splitBuildLog(log: string): string[] {
  if (log === '') {
    return []
  }
  const lines = log.split('\n')
  return lines.at(-1) === '' ? lines.slice(0, -1) : lines
}

// "0 failed", "no errors" and the like report success.
const NEGATED_ERROR = /\b(0|no|zero)\s+(errors?|failed|failures?)\b/i

export function isBuildLogErrorLine(line: string): boolean {
  return (ERROR_WORD.test(line) || ERRNO.test(line)) && !NEGATED_ERROR.test(line)
}

export function firstBuildLogErrorLine(log: string): string | null {
  return splitBuildLog(log).find(isBuildLogErrorLine)?.trim() ?? null
}

// Recipe stderr explains both slow progress and failures, so the log follows output until the user scrolls up.
export function VmBuildLog({
  id,
  log,
  stamps,
  startedAt,
  emptyLabel,
  formatLine
}: {
  id?: string
  log: string
  /** Arrival time of each line, index-aligned with the log's lines. */
  stamps: readonly number[]
  startedAt: number
  emptyLabel: string
  /** Rewrites a line for display, or hides it with null; Copy log still takes the raw log. */
  formatLine?: (line: string) => string | null
}): React.JSX.Element {
  const t = useTranslate()
  const ref = React.useRef<HTMLDivElement>(null)
  const firstErrorRef = React.useRef<HTMLDivElement>(null)
  const pinnedToBottomRef = React.useRef(true)
  const [copied, setCopied] = React.useState(false)
  // The sheet re-renders every clock tick; only a new log needs re-scanning.
  const { rows, hiddenCount } = React.useMemo(() => {
    const all = splitBuildLog(log).map((line, position) => ({
      // Lines only append or trim from the front, so position plus text identifies a row.
      id: `${position}:${line}`,
      text: formatLine ? formatLine(line) : line,
      stamp: stamps[position],
      isError: isBuildLogErrorLine(line)
    }))
    const visible = all.filter(
      (row): row is (typeof all)[number] & { text: string } => row.text !== null
    )
    return { rows: visible, hiddenCount: all.length - visible.length }
  }, [log, formatLine, stamps])
  const firstError = rows.findIndex((row) => row.isError)

  const handleScroll = React.useCallback((): void => {
    const el = ref.current
    if (el) {
      pinnedToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 8
    }
  }, [])
  React.useEffect(() => {
    const el = ref.current
    if (el && pinnedToBottomRef.current) {
      el.scrollTop = el.scrollHeight
    }
  }, [log])
  React.useEffect(() => {
    if (!copied) {
      return
    }
    const timer = window.setTimeout(() => setCopied(false), 1500)
    return () => window.clearTimeout(timer)
  }, [copied])

  const jumpToFirstError = (): void => {
    const el = ref.current
    const line = firstErrorRef.current
    if (!el || !line) {
      return
    }
    pinnedToBottomRef.current = false
    el.scrollTop = Math.max(0, line.offsetTop - 8)
    line.focus({ preventScroll: true })
  }
  const copy = (): void => {
    void window.api.ui
      .writeClipboardText(log)
      .then(() => setCopied(true))
      .catch(() => {
        toast.error(
          t('auto.components.worktree.creation.VmBuildLog.copyFailed', 'Couldn’t copy the log.')
        )
      })
  }

  return (
    <div className="flex flex-col gap-1.5">
      {log !== '' ? (
        <div className="flex items-center justify-end gap-1">
          {hiddenCount > 0 ? (
            <span className="mr-auto text-xs text-muted-foreground">
              {t(
                'auto.components.worktree.creation.VmBuildLog.hiddenTechnicalLines',
                '{{count}} technical lines hidden. Copy log includes them.',
                {
                  count: hiddenCount,
                  defaultValue_one: '{{count}} technical line hidden. Copy log includes it.'
                }
              )}
            </span>
          ) : null}
          {firstError !== -1 ? (
            <Button type="button" variant="ghost" size="xs" onClick={jumpToFirstError}>
              <ArrowDownToLine />
              {t('auto.components.worktree.creation.VmBuildLog.jumpToError', 'Jump to first error')}
            </Button>
          ) : null}
          <Button type="button" variant="ghost" size="xs" onClick={copy}>
            {copied ? <Check /> : <Copy />}
            {copied
              ? t('auto.components.worktree.creation.VmBuildLog.copied', 'Copied')
              : t('auto.components.worktree.creation.VmBuildLog.copy', 'Copy log')}
          </Button>
          <span className="sr-only" aria-live="polite">
            {copied
              ? t('auto.components.worktree.creation.VmBuildLog.copiedStatus', 'Log copied')
              : ''}
          </span>
        </div>
      ) : null}
      <div
        id={id}
        ref={ref}
        onScroll={handleScroll}
        role="log"
        aria-live="off"
        aria-label={t('auto.components.worktree.creation.VmBuildLog.label', 'Build log')}
        tabIndex={0}
        className="scrollbar-sleek relative max-h-72 overflow-auto rounded-md bg-muted/40 py-2 font-mono text-xs leading-5 text-muted-foreground outline-none focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
      >
        {rows.length === 0 ? (
          <div className="px-3">{emptyLabel}</div>
        ) : (
          rows.map((row, index) => {
            const { stamp } = row
            return (
              <div
                key={row.id}
                ref={index === firstError ? firstErrorRef : undefined}
                tabIndex={index === firstError ? -1 : undefined}
                className={cn(
                  'flex gap-3 px-3 outline-none focus-visible:outline-2 focus-visible:outline-solid focus-visible:-outline-offset-2 focus-visible:outline-focus-ring',
                  row.isError && 'font-medium text-destructive'
                )}
              >
                <span className="w-12 shrink-0 select-none text-right tabular-nums text-muted-foreground">
                  {stamp === undefined ? '' : formatElapsedTime(stamp - startedAt)}
                </span>
                <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">{row.text}</span>
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}
