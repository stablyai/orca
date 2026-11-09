import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore
} from 'react'
import { ArrowDown, Check, Copy } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useDocumentDarkTheme } from '@/hooks/use-document-dark-theme'
import { useTranslate } from '@/i18n/use-translate'
import type { BuildLogBuffer } from './build-log-model'
import {
  defaultExpanded,
  failureScrollRow,
  lastRowBoundary,
  rowAtIndex,
  type Row,
  type Segment
} from './log-row-layout'
import { HEADER_ROW_PX, LINE_ROW_PX, useLogVirtualizer } from './use-log-virtualizer'
import { deriveBuildSteps, focusStep, formatStepDuration } from './build-steps'
import {
  EmptyStepRow,
  FailureSummary,
  LogFooter,
  LogLineRow,
  stepAnnouncement,
  StepHeaderRow
} from './BuildLogRows'
import { FOCUS_RING } from '../orca-cloud/cloud-focus'
import { cn } from '@/lib/utils'
import { BuildStatusIcon, stepStatusFromBuild, useNow } from './BuildStatusIcon'
import { buildStatusLabel, isBuildInProgress } from './cloud-environment-copy'
import type { EnvironmentBuildStep, EnvironmentBuildView } from './cloud-environment-types'
import { autoscrollReducer, initialAutoscrollState } from './log-autoscroll'

export type BuildLogStreamState = 'connecting' | 'live' | 'reconnecting' | 'ended' | 'error'

/** A whole number of lines; the viewport then stops at the last whole row below it. */
const MAX_LOG_HEIGHT_PX = 23 * LINE_ROW_PX

/** Memoized: the panel re-renders on polls and status changes that don't touch this build. */
export const BuildLogViewer = memo(function BuildLogViewer({
  build,
  buffer,
  activeBuildNumber,
  streamState,
  streamError,
  onRetryStream,
  height = MAX_LOG_HEIGHT_PX,
  now: fixedNow
}: {
  build: EnvironmentBuildView
  buffer: BuildLogBuffer
  activeBuildNumber: number | null
  streamState: BuildLogStreamState
  streamError?: string | null
  onRetryStream?: () => void
  height?: number
  /** Freeze the clock (fixtures). */
  now?: number
}): React.JSX.Element {
  const t = useTranslate()
  const dark = useDocumentDarkTheme()
  const running = isBuildInProgress(build.status)
  // While the stream is down the last-known state is stale: freeze the clock instead of guessing.
  const disconnected = streamState === 'reconnecting' || streamState === 'error'
  const tickingNow = useNow(running && !disconnected && fixedNow === undefined)
  const now = fixedNow ?? tickingNow
  const version = useSyncExternalStore(buffer.subscribe, buffer.getVersion)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  // Follow the tail of a live build; a finished one opens at the top (or at its failure).
  const [scroll, dispatch] = useReducer(autoscrollReducer, running, (live) => ({
    ...initialAutoscrollState,
    following: live
  }))
  const [toggled, setToggled] = useState<Partial<Record<EnvironmentBuildStep, boolean>>>({})
  const [copied, setCopied] = useState(false)
  const pending = useRef<{ copiedTimer: number | null; showErrorFrame: number | null }>({
    copiedTimer: null,
    showErrorFrame: null
  })
  useEffect(() => {
    const handles = pending.current
    return () => {
      if (handles.copiedTimer !== null) {
        window.clearTimeout(handles.copiedTimer)
      }
      if (handles.showErrorFrame !== null) {
        cancelAnimationFrame(handles.showErrorFrame)
      }
    }
  }, [])

  // `version` is the external-store tick: markers and line counts are read off the mutable buffer.
  const steps = useMemo(
    () => deriveBuildSteps(build, buffer.markers, now),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- buffer is mutable; version tracks it.
    [build, buffer, version, now]
  )
  const focus = focusStep(steps)
  const lineTotal = buffer.lines.length
  const showTimestamps = useMemo(
    () => buffer.lines.length > 0 && buffer.lines[0].at !== null,
    // eslint-disable-next-line react-hooks/exhaustive-deps -- buffer is mutable; version tracks it.
    [buffer, version]
  )

  const segments = useMemo((): Segment[] => {
    let row = 0
    return steps.map((step) => {
      const range = buffer.stepRange(step.id)
      const lineCount = range.end - range.start
      const expanded = toggled[step.id] ?? defaultExpanded(step, focus, build)
      const bodyRows = expanded ? Math.max(lineCount, step.status === 'pending' ? 0 : 1) : 0
      const segment = {
        step,
        firstRow: row,
        rowCount: 1 + bodyRows,
        lineStart: range.start,
        lineCount,
        expanded
      }
      row += segment.rowCount
      return segment
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- buffer is mutable; version tracks it.
  }, [steps, toggled, focus, build, buffer, version])

  const rowCount = segments.reduce((sum, segment) => sum + segment.rowCount, 0)

  const rowAt = useCallback(
    (index: number): Row => rowAtIndex(segments, buffer, index),
    [segments, buffer]
  )

  const virtualizer = useLogVirtualizer(segments, buffer, rowCount, scrollRef)

  // Count lines that arrived while the user was reading history (feeds the pill).
  const seenLines = useRef(lineTotal)
  useLayoutEffect(() => {
    const delta = lineTotal - seenLines.current
    seenLines.current = lineTotal
    if (delta > 0) {
      dispatch({ type: 'append', count: delta })
    } else if (delta < 0) {
      dispatch({ type: 'reset' })
    }
  }, [lineTotal])

  // Follow the tail: jump (not smooth-scroll) so a fast log never lags behind its own output.
  useLayoutEffect(() => {
    if (scroll.following && rowCount > 0) {
      virtualizer.scrollToIndex(rowCount - 1, { align: 'end' })
    }
  }, [scroll.following, rowCount, version, virtualizer])

  // Hug short logs instead of leaving an empty slab; cap long ones on a row boundary.
  const totalSize = virtualizer.getTotalSize()
  const overflowing = totalSize > height
  // Overflowing logs stop at the last whole row that fits from the top (rows are whole lines, but
  // headers are two), so the resting view never shows half a row.
  const viewportHeight = overflowing
    ? lastRowBoundary(virtualizer.measurementsCache, height - (height % LINE_ROW_PX))
    : totalSize

  // A failed build opens on its failure, once its log is complete ('ended'): earlier, the log is
  // still replaying and the error line may not exist yet, so the scroll would land short.
  const failedStepId = build.status === 'failed' ? focus : null
  const scrolledToFailure = useRef<string | null>(null)
  useLayoutEffect(() => {
    if (!failedStepId || scrolledToFailure.current === build.id || streamState !== 'ended') {
      return
    }
    scrolledToFailure.current = build.id
    const row = failureScrollRow(segments, buffer, failedStepId, {
      height: viewportHeight,
      totalSize: virtualizer.getTotalSize(),
      headerPx: HEADER_ROW_PX,
      linePx: LINE_ROW_PX
    })
    if (row !== null) {
      dispatch({ type: 'release' })
      virtualizer.scrollToIndex(row, { align: 'start' })
    }
  }, [failedStepId, build.id, segments, buffer, virtualizer, streamState, viewportHeight])

  const onScroll = (): void => {
    const element = scrollRef.current
    if (element) {
      dispatch({
        type: 'scroll',
        scrollTop: element.scrollTop,
        scrollHeight: element.scrollHeight,
        clientHeight: element.clientHeight
      })
    }
  }

  const jumpToLatest = (): void => {
    dispatch({ type: 'jump' })
    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    virtualizer.scrollToIndex(rowCount - 1, {
      align: 'end',
      behavior: reduceMotion ? 'auto' : 'smooth'
    })
  }

  const onScrollerKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.target !== event.currentTarget || rowCount === 0) {
      return
    }
    if (event.key === 'Home') {
      event.preventDefault()
      dispatch({ type: 'release' })
      virtualizer.scrollToIndex(0, { align: 'start' })
    } else if (event.key === 'End') {
      event.preventDefault()
      dispatch({ type: 'jump' })
      virtualizer.scrollToIndex(rowCount - 1, { align: 'end' })
    }
  }

  const showError = (): void => {
    const index = buffer.orcaErrorLines.at(-1)
    const segment =
      index === undefined
        ? undefined
        : segments.find(
            (entry) => index >= entry.lineStart && index < entry.lineStart + entry.lineCount
          )
    if (index === undefined || !segment) {
      return
    }
    dispatch({ type: 'release' })
    if (!segment.expanded) {
      setToggled((previous) => ({ ...previous, [segment.step.id]: true }))
    }
    // After an expand the rows move; scroll on the next frame.
    pending.current.showErrorFrame = requestAnimationFrame(() => {
      pending.current.showErrorFrame = null
      virtualizer.scrollToIndex(segment.firstRow + 1 + (index - segment.lineStart), {
        align: 'start'
      })
    })
  }

  const toggle = useCallback(
    (stepId: EnvironmentBuildStep) => {
      setToggled((previous) => {
        const step = steps.find((entry) => entry.id === stepId)
        const current = previous[stepId] ?? (step ? defaultExpanded(step, focus, build) : false)
        return { ...previous, [stepId]: !current }
      })
    },
    [steps, focus, build]
  )

  const copyLogs = (): void => {
    // Machine-readable codes live here, not in the UI copy (they help support and agents).
    const header = [
      `build=${build.id} number=${build.number} status=${build.status}`,
      build.failedStep ? `failedStep=${build.failedStep}` : null,
      build.error ? `error=${build.error}` : null,
      streamError ? `stream=${streamError}` : null
    ]
      .filter(Boolean)
      .join(' ')
    void window.api.ui.writeClipboardText(`${header}\n${buffer.text()}`).then(() => {
      setCopied(true)
      if (pending.current.copiedTimer !== null) {
        window.clearTimeout(pending.current.copiedTimer)
      }
      pending.current.copiedTimer = window.setTimeout(() => {
        pending.current.copiedTimer = null
        setCopied(false)
      }, 1500)
    })
  }

  const totalMs = build.durationMs ?? (running ? Math.max(0, now - build.createdAt) : null)
  const statusWord = buildStatusLabel(build.status, t)
  const failure = build.status === 'failed'
  const items = virtualizer.getVirtualItems()

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border px-3 py-2">
        <BuildStatusIcon
          status={disconnected && running ? 'paused' : stepStatusFromBuild(build.status)}
        />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">
            {t('cloudEnvironment.log.title', 'Build #{{number}}', {
              number: String(build.number)
            })}
            <span className="font-normal text-muted-foreground">
              {' · '}
              {disconnected && running
                ? streamState === 'reconnecting'
                  ? t('cloudEnvironment.log.reconnectingShort', 'Reconnecting…')
                  : t('cloudEnvironment.log.disconnectedShort', '{{status}} · log disconnected', {
                      status: statusWord
                    })
                : statusWord}
            </span>
          </p>
        </div>
        <span className="text-xs tabular-nums text-muted-foreground">
          {formatStepDuration(totalMs)}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          onClick={copyLogs}
          disabled={lineTotal === 0}
          aria-label={t('cloudEnvironment.log.copyAria', 'Copy build log')}
        >
          {copied ? <Check /> : <Copy />}
          <span role="status" className="sr-only">
            {copied ? t('cloudEnvironment.log.copiedAnnounce', 'Build log copied') : ''}
          </span>
          {copied
            ? t('cloudEnvironment.log.copied', 'Copied')
            : t('cloudEnvironment.log.copy', 'Copy logs')}
        </Button>
      </div>

      <p role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {stepAnnouncement(build, steps, activeBuildNumber, t)}
      </p>

      {failure ? (
        <FailureSummary
          build={build}
          activeBuildNumber={activeBuildNumber}
          onShowError={buffer.orcaErrors.length > 0 ? showError : null}
        />
      ) : null}

      <div className="relative">
        <div
          ref={scrollRef}
          onScroll={onScroll}
          // Not role=log: a virtualized log would announce every row as it scrolls into view.
          // Progress is announced per step by the status region above.
          role="region"
          aria-live="off"
          aria-label={t('cloudEnvironment.log.aria', 'Build #{{number}} log', {
            number: String(build.number)
          })}
          aria-busy={streamState === 'connecting'}
          aria-keyshortcuts="Home End"
          tabIndex={0}
          onKeyDown={onScrollerKeyDown}
          onFocus={(event) => {
            // Keyboard focus on a step header: stop following, or the next chunk scrolls it away.
            if (event.target !== event.currentTarget) {
              dispatch({ type: 'release' })
            }
          }}
          className={cn(
            'overflow-y-auto overscroll-contain bg-muted/30 font-mono text-xs text-foreground scrollbar-editor dark:bg-black/25',
            FOCUS_RING,
            'focus-visible:ring-inset'
          )}
          style={{ height: viewportHeight }}
        >
          <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
            {items.map((item) => {
              const row = rowAt(item.index)
              return (
                <div
                  key={item.key}
                  data-index={item.index}
                  ref={virtualizer.measureElement}
                  className="absolute top-0 left-0 w-full"
                  style={{ transform: `translateY(${item.start}px)` }}
                >
                  {row.kind === 'header' ? (
                    <StepHeaderRow
                      step={row.step}
                      lineCount={row.lineCount}
                      expanded={
                        segments.find((entry) => entry.step.id === row.step.id)?.expanded ?? false
                      }
                      paused={disconnected && running}
                      onToggle={toggle}
                    />
                  ) : row.kind === 'line' ? (
                    <LogLineRow
                      line={row.line}
                      number={row.number}
                      origin={build.createdAt}
                      showTimestamps={showTimestamps}
                      dark={dark}
                    />
                  ) : (
                    <EmptyStepRow step={row.step} build={build} streamState={streamState} />
                  )}
                </div>
              )
            })}
          </div>
        </div>
        {running && !scroll.following && scroll.awayFromBottom && rowCount > 0 ? (
          <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-1">
            <Button
              type="button"
              size="xs"
              variant="secondary-floating"
              onClick={jumpToLatest}
              className="pointer-events-auto"
            >
              <ArrowDown />
              {scroll.unseen > 0
                ? t('cloudEnvironment.log.jumpWithCount', 'Jump to latest ({{total}} new)', {
                    total: String(scroll.unseen)
                  })
                : t('cloudEnvironment.log.jump', 'Jump to latest')}
            </Button>
          </div>
        ) : null}
      </div>

      <LogFooter
        streamState={running ? streamState : streamState === 'reconnecting' ? 'live' : streamState}
        streamError={streamError ?? null}
        truncated={build.logTruncated}
        onRetry={onRetryStream}
      />
    </div>
  )
})
