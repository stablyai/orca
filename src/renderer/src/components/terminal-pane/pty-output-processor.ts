import { extractAllOscTitles } from '../../../../shared/agent-detection'
import {
  createAgentStatusOscProcessor,
  type ProgramActivityChange
} from '../../../../shared/agent-status-osc'
import { createProgramStatusSideEffectScanner } from '../../../../shared/terminal-agent-status-processor'
import { extractAllOscTitleEntries } from '../../../../shared/osc-title-extraction'
import { placeProgramActivityAmongTitles } from '../../../../shared/program-status/title-activity-order'
import {
  enqueueOrderedPtyEffects,
  removeSuppressedCursorNativeTitles
} from './pty-output-effect-ordering'
import { createBellDetector } from '../../../../shared/terminal-bell-detector'
import type { PtyDataMeta } from './pty-dispatcher'
import {
  createPtyOutputSideEffectQueue,
  type PendingPtySideEffect
} from './pty-output-side-effect-queue'
import { createPtyOutputTitleObserver } from './pty-output-title-observer'
import { advancePartialEscapeTail } from '../../../../shared/terminal-partial-escape-tail'
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
  carriesNormalBuffer?: boolean
  carriesHistory?: boolean
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
  let scanProgramStatus = createProgramStatusSideEffectScanner()
  let partialEscapeTail = ''
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
      // Why seeded on replay: like replayed titles, restored bytes must not move live status, yet the
      // tracker must still agree with the scanner, which only reports later changes.
      for (const activity of effect.programActivity ?? []) {
        if (effect.suppressAttentionEvents) {
          titleObserver.seedProgramActivity(activity)
        } else {
          titleObserver.applyProgramActivity(activity)
        }
      }
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
    suppressAttentionEvents: boolean,
    programActivity: readonly ProgramActivityChange[]
  ): void {
    const scannedForTitles = Boolean(onTitleChange && data.includes('\x1b]'))
    // Why offsets only with activity: ordinary chunks keep the cheaper title-only scan.
    const titleEntries =
      scannedForTitles && programActivity.length > 0 ? extractAllOscTitleEntries(data) : null
    const titles = titleEntries
      ? titleEntries.map((entry) => entry.title)
      : scannedForTitles
        ? extractAllOscTitles(data)
        : []
    const titleEnds = titleEntries?.map((entry) => entry.end)
    const ignoredCursorNativeTitle = removeSuppressedCursorNativeTitles(
      titles,
      sideEffects.isDrained() ? titleObserver.getLastEmittedTitle() : null,
      titleEnds
    )
    const placedActivity =
      programActivity.length > 0
        ? placeProgramActivityAmongTitles(titleEnds ?? [], programActivity)
        : []
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
    if (
      !shouldEmitEmptyTitleScan &&
      deliveredPayloads.length === 0 &&
      !containsBell &&
      placedActivity.length === 0
    ) {
      return
    }

    if (deliveredPayloads.length === 0 && titles.length === 0) {
      sideEffects.enqueue({
        ...(placedActivity.length > 0
          ? { programActivity: placedActivity.map(({ activity }) => activity) }
          : {}),
        payloads: [],
        titles: [],
        titleScanEffect,
        containsBell,
        suppressAttentionEvents
      })
    } else {
      enqueueOrderedPtyEffects(sideEffects.enqueue, {
        payloads: deliveredPayloads,
        titles,
        placedActivity,
        emptyTitleScanEffect: shouldEmitEmptyTitleScan ? titleScanEffect : 'none',
        containsBell,
        suppressAttentionEvents
      })
    }
    sideEffects.scheduleDrain()
  }

  function processData(
    data: string,
    callbacks: PtyOutputCallbacks,
    options: ProcessPtyOutputOptions = {},
    meta?: PtyDataMeta
  ): void {
    const rawLength = meta?.rawLength ?? data.length
    const suppressAttentionEvents = options.suppressAttentionEvents === true
    partialEscapeTail = advancePartialEscapeTail(partialEscapeTail, data)
    if (options.pendingEscapeTailAnsi) {
      partialEscapeTail = options.pendingEscapeTailAnsi
    }
    const processed = processAgentStatusChunk(data)
    data = processed.cleanData
    const programStatus = scanProgramStatus(data)
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
          : {}),
        ...(options.carriesNormalBuffer ? { carriesNormalBuffer: true } : {}),
        ...(options.carriesHistory ? { carriesHistory: true } : {})
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
    // Why only activity: the execution host owns OSC 7501 rows, their lifetime and hook precedence.
    enqueueSideEffects(data, processed.payloads, suppressAttentionEvents, programStatus.activity)
  }

  return {
    processData,
    clearAccumulatedState: () => {
      sideEffects.clear()
      titleObserver.reset()
      // Reset together: the scanner only reports changes against the activity the tracker held.
      scanProgramStatus = createProgramStatusSideEffectScanner()
      bellDetector.reset()
      partialEscapeTail = ''
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
      scanProgramStatus = createProgramStatusSideEffectScanner()
    },
    getPendingEscapeTailAnsi: () => partialEscapeTail,
    disposePendingSideEffectGauge: sideEffects.disposeGauge
  }
}
