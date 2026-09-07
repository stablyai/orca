import {
  extractAllOscTitles,
  isCursorNativeAgentTitle,
  normalizeTerminalTitle,
  shouldSuppressCursorNativeTitle
} from '../../../../shared/agent-detection'
import { createAgentStatusOscProcessor } from '../../../../shared/agent-status-osc'
import { createBellDetector } from '../../../../shared/terminal-bell-detector'
import type { PtyDataMeta } from './pty-dispatcher'
import {
  createPtyOutputSideEffectQueue,
  type PendingPtySideEffect
} from './pty-output-side-effect-queue'
import { createPtyOutputTitleObserver } from './pty-output-title-observer'
import type { IpcPtyTransportOptions, PtyTransport } from './pty-transport-types'

type PtyOutputCallbacks = Parameters<PtyTransport['connect']>[0]['callbacks']

export type PtyOutputProcessorOptions = Pick<
  IpcPtyTransportOptions,
  | 'onTitleChange'
  | 'onBell'
  | 'onAgentBecameIdle'
  | 'onAgentBecameWorking'
  | 'onAgentExited'
  | 'onAgentStatus'
> & {
  initialAgentTitle?: string
}

export type ProcessPtyOutputOptions = {
  replayingBufferedData?: boolean
  suppressAttentionEvents?: boolean
  clearBeforeReplay?: boolean
  pendingEscapeTailAnsi?: string
  kittyKeyboardFlags?: number
  snapshotSeq?: number
  alternateScreen?: boolean
  terminalOwner?: 'shell'
  snapshotCols?: number
  snapshotRows?: number
}

function removeSuppressedCursorNativeTitles(
  titles: string[],
  precedingTitle: string | null
): boolean {
  let writeIndex = 0
  let previousTitle = precedingTitle
  for (const title of titles) {
    if (isCursorNativeAgentTitle(title) && shouldSuppressCursorNativeTitle(previousTitle)) {
      continue
    }
    previousTitle = normalizeTerminalTitle(title)
    titles[writeIndex] = title
    writeIndex += 1
  }
  const removed = writeIndex < titles.length
  titles.length = writeIndex
  return removed
}

export function createPtyOutputProcessor({
  onTitleChange,
  onBell,
  onAgentBecameIdle,
  onAgentBecameWorking,
  onAgentExited,
  onAgentStatus,
  initialAgentTitle
}: PtyOutputProcessorOptions) {
  const bellDetector = createBellDetector()
  let processAgentStatusChunk = createAgentStatusOscProcessor()
  const titleObserver = createPtyOutputTitleObserver({
    onTitleChange,
    onAgentBecameIdle,
    onAgentBecameWorking,
    onAgentExited,
    initialAgentTitle
  })
  const sideEffects = createPtyOutputSideEffectQueue({
    countWorkingTitles: titleObserver.countWorkingTitles,
    apply: (effect) => {
      if (onAgentStatus) {
        for (const payload of effect.payloads) {
          onAgentStatus(payload)
        }
      }
      titleObserver.processObservedTitles(
        effect.titles,
        effect.titleScanEffect,
        effect.suppressAttentionEvents
      )
      if (onBell && effect.containsBell) {
        onBell()
      }
    }
  })

  function enqueueSideEffects(
    data: string,
    payloads: ReturnType<typeof processAgentStatusChunk>['payloads'],
    suppressAttentionEvents: boolean
  ): void {
    const scannedForTitles = Boolean(onTitleChange && data.includes('\x1b]'))
    const titles = scannedForTitles ? extractAllOscTitles(data) : []
    const ignoredCursorNativeTitle = removeSuppressedCursorNativeTitles(
      titles,
      sideEffects.isDrained() ? titleObserver.getLastEmittedTitle() : null
    )
    const deliveredPayloads =
      onAgentStatus && !suppressAttentionEvents && payloads.length > 0 ? payloads : []
    const containsBell = Boolean(
      onBell && !suppressAttentionEvents && bellDetector.chunkContainsBell(data)
    )
    const needsStaleTitleProbe = Boolean(
      onTitleChange &&
      data.length > 0 &&
      titles.length === 0 &&
      !suppressAttentionEvents &&
      (titleObserver.countWorkingTitles([titleObserver.getLastEmittedTitle() ?? '']) > 0 ||
        sideEffects.pendingWorkingTitleCount() > 0)
    )
    const shouldEmitEmptyTitleScan = scannedForTitles || needsStaleTitleProbe
    const titleScanEffect: PendingPtySideEffect['titleScanEffect'] = ignoredCursorNativeTitle
      ? 'ignored-cursor-native'
      : shouldEmitEmptyTitleScan
        ? 'stale-probe'
        : 'none'
    if (!shouldEmitEmptyTitleScan && deliveredPayloads.length === 0 && !containsBell) {
      return
    }

    if (deliveredPayloads.length === 0 && titles.length === 0) {
      sideEffects.enqueue({
        payloads: [],
        titles: [],
        titleScanEffect,
        containsBell,
        suppressAttentionEvents
      })
    } else {
      enqueueOrderedEffects(
        deliveredPayloads,
        titles,
        shouldEmitEmptyTitleScan ? titleScanEffect : 'none',
        containsBell,
        suppressAttentionEvents
      )
    }
    sideEffects.scheduleDrain()
  }

  function enqueueOrderedEffects(
    payloads: ReturnType<typeof processAgentStatusChunk>['payloads'],
    titles: string[],
    emptyTitleScanEffect: PendingPtySideEffect['titleScanEffect'],
    containsBell: boolean,
    suppressAttentionEvents: boolean
  ): void {
    for (const payload of payloads) {
      sideEffects.enqueue({
        payloads: [payload],
        titles: [],
        titleScanEffect: 'none',
        containsBell: false,
        suppressAttentionEvents
      })
    }
    if (titles.length === 0 && emptyTitleScanEffect !== 'none') {
      sideEffects.enqueue({
        payloads: [],
        titles: [],
        titleScanEffect: emptyTitleScanEffect,
        containsBell: false,
        suppressAttentionEvents
      })
    }
    for (const title of titles) {
      sideEffects.enqueue({
        payloads: [],
        titles: [title],
        titleScanEffect: 'none',
        containsBell: false,
        suppressAttentionEvents
      })
    }
    if (containsBell) {
      sideEffects.enqueue({
        payloads: [],
        titles: [],
        titleScanEffect: 'none',
        containsBell: true,
        suppressAttentionEvents
      })
    }
  }

  function processData(
    data: string,
    callbacks: PtyOutputCallbacks,
    options: ProcessPtyOutputOptions = {},
    meta?: PtyDataMeta
  ): void {
    const rawLength = meta?.rawLength ?? data.length
    const suppressAttentionEvents = options.suppressAttentionEvents === true
    const processed = processAgentStatusChunk(data)
    data = processed.cleanData
    if (options.replayingBufferedData && callbacks.onReplayData) {
      const replayMeta = {
        ...(options.clearBeforeReplay === false ? { clearBeforeReplay: false } : {}),
        ...(options.pendingEscapeTailAnsi
          ? { pendingEscapeTailAnsi: options.pendingEscapeTailAnsi }
          : {}),
        ...(options.kittyKeyboardFlags !== undefined
          ? { kittyKeyboardFlags: options.kittyKeyboardFlags }
          : {}),
        ...(options.snapshotSeq !== undefined ? { snapshotSeq: options.snapshotSeq } : {}),
        ...(options.alternateScreen !== undefined
          ? { alternateScreen: options.alternateScreen }
          : {}),
        ...(options.terminalOwner ? { terminalOwner: options.terminalOwner } : {}),
        ...(options.snapshotCols !== undefined && options.snapshotRows !== undefined
          ? { snapshotCols: options.snapshotCols, snapshotRows: options.snapshotRows }
          : {})
      }
      if (Object.keys(replayMeta).length > 0) {
        callbacks.onReplayData(data, replayMeta)
      } else {
        callbacks.onReplayData(data)
      }
    } else if (meta) {
      callbacks.onData?.(data, { ...meta, rawLength })
    } else {
      callbacks.onData?.(data)
    }
    enqueueSideEffects(data, processed.payloads, suppressAttentionEvents)
  }

  return {
    processData,
    clearAccumulatedState: () => {
      sideEffects.clear()
      titleObserver.reset()
      bellDetector.reset()
    },
    pausePendingSideEffects: () => {
      sideEffects.pause()
      titleObserver.clearStaleTitleTimer()
    },
    clearStaleTitleTimer: titleObserver.clearStaleTitleTimer,
    flushPendingSideEffects: sideEffects.flush,
    resetBellDetector: () => bellDetector.reset(),
    resetAgentStatusCarry: () => {
      processAgentStatusChunk = createAgentStatusOscProcessor()
    },
    disposePendingSideEffectGauge: sideEffects.disposeGauge
  }
}
