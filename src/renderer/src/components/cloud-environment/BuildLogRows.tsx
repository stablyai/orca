import { memo } from 'react'
import type { ITheme } from '@xterm/xterm'
import { AlertTriangle, ChevronRight } from 'lucide-react'
import { getBuiltinTheme } from '@/lib/terminal-theme'
import { cn } from '@/lib/utils'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import { Button } from '@/components/ui/button'
import { InlineError } from '@/components/ui/inline-error'
import { FOCUS_RING } from '../orca-cloud/cloud-focus'
import {
  DEFAULT_TERMINAL_THEME_DARK,
  DEFAULT_TERMINAL_THEME_LIGHT
} from '../../../../shared/terminal-themes/terminal-theme-selection'
import { parseAnsiSegments, type AnsiColor } from '../editor/notebook/outputs/ipynb-ansi'
import type { LogLine } from './build-log-model'
import { formatLineTimestamp, formatStepDuration, type BuildStepView } from './build-steps'
import { BuildStatusIcon } from './BuildStatusIcon'
import type { BuildLogStreamState } from './BuildLogViewer'
import { buildErrorCopy, failedBuildSummary, stepLabel } from './cloud-environment-copy'
import type { EnvironmentBuildStep, EnvironmentBuildView } from './cloud-environment-types'

/** Lines longer than this render truncated (the copy keeps them whole); minified bundles exist. */
const MAX_RENDERED_LINE_CHARS = 2000

const ANSI_PALETTE_KEYS = [
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',
  'brightBlack',
  'brightRed',
  'brightGreen',
  'brightYellow',
  'brightBlue',
  'brightMagenta',
  'brightCyan',
  'brightWhite'
] as const satisfies readonly (keyof ITheme)[]

const ANSI_PALETTES = {
  dark: ANSI_PALETTE_KEYS.map((key) => getBuiltinTheme(DEFAULT_TERMINAL_THEME_DARK)?.[key]),
  light: ANSI_PALETTE_KEYS.map((key) => getBuiltinTheme(DEFAULT_TERMINAL_THEME_LIGHT)?.[key])
}

function AnsiLine({ text, dark }: { text: string; dark: boolean }): React.JSX.Element {
  const palette = ANSI_PALETTES[dark ? 'dark' : 'light']
  const resolve = (color: AnsiColor | undefined): string | undefined =>
    typeof color === 'number' ? palette[color] : color
  const clipped =
    text.length > MAX_RENDERED_LINE_CHARS ? `${text.slice(0, MAX_RENDERED_LINE_CHARS)}…` : text
  return (
    <>
      {parseAnsiSegments(clipped).map((segment, index) =>
        segment.fg === undefined && segment.bg === undefined && !segment.bold ? (
          <span key={index}>{segment.text}</span>
        ) : (
          <span
            key={index}
            style={{
              color: resolve(segment.fg),
              backgroundColor: resolve(segment.bg),
              fontWeight: segment.bold ? 600 : undefined,
              fontStyle: segment.italic ? 'italic' : undefined,
              textDecoration: segment.underline ? 'underline' : undefined
            }}
          >
            {segment.text}
          </span>
        )
      )}
    </>
  )
}

export const LogLineRow = memo(function LogLineRow({
  line,
  number,
  origin,
  showTimestamps,
  dark
}: {
  line: LogLine
  number: number
  origin: number
  showTimestamps: boolean
  dark: boolean
}): React.JSX.Element {
  if (line.kind === 'orca-error') {
    return (
      <div className="px-3 py-1.5">
        <div
          role="note"
          className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 font-sans text-xs leading-5 text-foreground"
        >
          <AlertTriangle aria-hidden className="mt-0.5 size-3.5 shrink-0 text-destructive" />
          <span className="whitespace-pre-wrap break-words">{line.plain}</span>
        </div>
      </div>
    )
  }
  return (
    <div
      className={cn(
        'group/line flex min-h-5 gap-3 px-3 leading-5 hover:bg-foreground/[0.04]',
        line.kind === 'error' && 'bg-destructive/10 text-destructive dark:text-red-300',
        line.kind === 'warning' && 'text-status-warning-text'
      )}
    >
      <span
        aria-hidden
        className="w-10 shrink-0 select-none text-right tabular-nums text-muted-foreground"
      >
        {number}
      </span>
      {showTimestamps ? (
        <span aria-hidden className="w-14 shrink-0 select-none tabular-nums text-muted-foreground">
          {formatLineTimestamp(line.at, origin)}
        </span>
      ) : null}
      <span className="min-w-0 flex-1 pl-[2ch] whitespace-pre-wrap [overflow-wrap:anywhere] [text-indent:-2ch]">
        <AnsiLine text={line.text} dark={dark} />
      </span>
    </div>
  )
})

export function StepHeaderRow({
  step,
  expanded,
  lineCount,
  paused = false,
  onToggle
}: {
  step: BuildStepView
  expanded: boolean
  lineCount: number
  /** The stream is down: show a running step frozen, not spinning. */
  paused?: boolean
  onToggle: (step: EnvironmentBuildStep) => void
}): React.JSX.Element {
  const t = useTranslate()
  const muted = step.status === 'pending' || step.status === 'skipped'
  return (
    <button
      type="button"
      aria-expanded={expanded}
      onClick={() => onToggle(step.id)}
      className={cn(
        'flex h-10 w-full items-center gap-2 border-t border-border/60 px-3 text-left font-sans text-[13px] first:border-t-0 hover:bg-foreground/[0.04] focus-visible:bg-foreground/[0.06]',
        FOCUS_RING,
        'focus-visible:ring-inset',
        muted && 'text-muted-foreground'
      )}
    >
      <ChevronRight
        aria-hidden
        className={cn(
          'size-3.5 shrink-0 text-muted-foreground transition-transform duration-150 motion-reduce:transition-none',
          expanded && 'rotate-90'
        )}
      />
      <BuildStatusIcon
        status={paused && step.status === 'running' ? 'paused' : step.status}
        className="size-3.5"
      />
      <span className={cn('min-w-0 flex-1 truncate', step.status === 'failed' && 'font-medium')}>
        {stepLabel(step.id, t)}
        <span className="sr-only">
          {', '}
          {stepStatusWord(step.status, t)}
        </span>
      </span>
      {lineCount > 0 ? (
        <span
          className="text-[11px] tabular-nums text-muted-foreground"
          title={t('cloudEnvironment.log.lineCountTitle', 'Lines of output')}
        >
          {lineCount.toLocaleString()}
        </span>
      ) : null}
      <span className="w-16 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
        {formatStepDuration(step.durationMs)}
      </span>
    </button>
  )
}

function stepStatusWord(
  status: BuildStepView['status'],
  t: ReturnType<typeof useTranslate>
): string {
  switch (status) {
    case 'running':
      return t('cloudEnvironment.stepStatus.running', 'running')
    case 'succeeded':
      return t('cloudEnvironment.stepStatus.succeeded', 'done')
    case 'failed':
      return t('cloudEnvironment.stepStatus.failed', 'failed')
    case 'canceled':
      return t('cloudEnvironment.stepStatus.canceled', 'canceled')
    case 'skipped':
      return t('cloudEnvironment.stepStatus.skipped', 'skipped')
    case 'pending':
      return t('cloudEnvironment.stepStatus.pending', 'waiting')
  }
}

export function EmptyStepRow({
  step,
  build,
  streamState
}: {
  step: EnvironmentBuildStep
  build: EnvironmentBuildView
  streamState: BuildLogStreamState
}): React.JSX.Element {
  const t = useTranslate()
  let copy: string
  if (streamState === 'connecting') {
    copy = t('cloudEnvironment.log.loading', 'Loading log…')
  } else if (step === 'boot') {
    copy = build.startedAt
      ? t('cloudEnvironment.log.bootDone', 'Sandbox started.')
      : t('cloudEnvironment.log.booting', 'Starting a fresh sandbox…')
  } else if (step === 'snapshot') {
    copy = build.finishedAt
      ? t('cloudEnvironment.log.snapshotDone', 'Snapshot saved.')
      : t('cloudEnvironment.log.snapshotting', 'Saving the snapshot…')
  } else {
    copy = t('cloudEnvironment.log.noOutput', 'No output.')
  }
  return (
    <div className="py-1 pr-3 pl-[4.25rem] font-sans text-xs leading-5 text-muted-foreground">
      {copy}
    </div>
  )
}

/** "Build #7 failed — workspaces still use #6", the failed step in words, and Orca's own diagnosis. */
export function FailureSummary({
  build,
  activeBuildNumber,
  onShowError
}: {
  build: EnvironmentBuildView
  activeBuildNumber: number | null
  /** Scrolls to Orca's own error note in the log; null when the log has none. */
  onShowError: (() => void) | null
}): React.JSX.Element {
  const t = useTranslate()
  const summary = failedBuildSummary(build.number, build.failedStep, activeBuildNumber, t)
  // Without an Orca note in the log, the plain-words reason is the only explanation there is.
  const reason = onShowError ? null : buildErrorCopy(build.error, t)
  return (
    <InlineError
      className="rounded-none border-x-0 border-t-0"
      title={summary.headline}
      detail={
        reason ? (
          <>
            {summary.consequence} {reason}
          </>
        ) : (
          summary.consequence
        )
      }
      action={
        onShowError ? (
          <Button type="button" variant="outline" size="xs" onClick={onShowError}>
            {t('cloudEnvironment.log.showError', 'Show error')}
          </Button>
        ) : undefined
      }
    />
  )
}

/** Stream health and truncation, below the log. Quiet unless something needs saying. */
export function LogFooter({
  streamState,
  streamError,
  truncated,
  onRetry
}: {
  streamState: BuildLogStreamState
  /** Main's plain-words reason when it stopped the watch. */
  streamError?: string | null
  truncated: boolean
  onRetry?: () => void
}): React.JSX.Element | null {
  const t = useTranslate()
  if (streamState === 'reconnecting' || streamState === 'error') {
    return (
      <InlineError
        tone="neutral"
        className="rounded-none border-x-0 border-b-0"
        title={t('cloudEnvironment.log.lostStatic', 'Lost connection to the build log.')}
        detail={
          streamState === 'reconnecting'
            ? t('cloudEnvironment.log.reconnectingDetail', 'Reconnecting… The build keeps running.')
            : (streamError ??
              t('cloudEnvironment.log.keepsRunning', 'The build keeps running in Orca Cloud.'))
        }
        {...(streamState === 'error' && onRetry
          ? { retryLabel: t('cloudEnvironment.log.reconnect', 'Reconnect'), onRetry }
          : {})}
      />
    )
  }
  if (!truncated) {
    return null
  }
  return (
    <p className="border-t border-border px-3 py-1.5 text-xs text-muted-foreground">
      {t('cloudEnvironment.log.truncatedShort', 'Log truncated at its size limit.')}
    </p>
  )
}

/** What screen readers hear as the build moves: one sentence per step change, never per line. */
export function stepAnnouncement(
  build: EnvironmentBuildView,
  steps: readonly BuildStepView[],
  activeBuildNumber: number | null,
  t: Translate
): string {
  if (build.status === 'failed') {
    const summary = failedBuildSummary(build.number, build.failedStep, activeBuildNumber, t)
    return t('cloudEnvironment.announce.failed', '{{headline}} {{consequence}}', summary)
  }
  if (build.status === 'succeeded') {
    return t('cloudEnvironment.announce.succeeded', 'Build #{{number}} succeeded.', {
      number: String(build.number)
    })
  }
  if (build.status === 'canceled') {
    return t('cloudEnvironment.announce.canceled', 'Build #{{number}} was canceled.', {
      number: String(build.number)
    })
  }
  const running = steps.find((step) => step.status === 'running')
  return running
    ? t('cloudEnvironment.announce.step', 'Build #{{number}}: {{step}}…', {
        number: String(build.number),
        step: stepLabel(running.id, t)
      })
    : ''
}
