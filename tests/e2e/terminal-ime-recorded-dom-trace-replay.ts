import type { Page } from '@stablyai/playwright-test'
import {
  samplePreeditOverlay,
  type PreeditOverlaySample
} from './terminal-ime-preedit-overlay-probe'

// Replay recorded events with per-composition geometry samples. CDP round-trips intentionally allow deferred positioning/layout between events.
export type RecordedImeDomEvent = {
  type: string
  data?: string
  inputType?: string
  key?: string
  code?: string
  keyCode?: number
  isComposing?: boolean
  value?: string
  selectionStart?: number
  selectionEnd?: number
}

export type RecordedImeDomTrace = {
  recordedFrom: string
  inputFramework: string
  engine: string
  /** Present on the Linux captures, where X11 and Wayland emit different orderings. */
  displayServer?: string
  note: string
  onData?: { data: string }[]
  dom: RecordedImeDomEvent[]
}

export type ReplayedCompositionSample = {
  index: number
  type: string
  data: string
  compositionOpen: boolean
  overlay: PreeditOverlaySample
}

export type RecordedTraceReplay = {
  samples: ReplayedCompositionSample[]
  onData: string
}

const COMPOSITION_EVENT_TYPES = new Set(['compositionstart', 'compositionupdate', 'compositionend'])

async function startRecordedTraceOnDataCapture(page: Page): Promise<void> {
  await page.evaluate(() => {
    const target = window as unknown as { __recordedTraceOnData: string[] }
    target.__recordedTraceOnData = []
    const state = window.__store?.getState()
    const worktreeId = state?.activeWorktreeId
    const tabId =
      state?.activeTabType === 'terminal'
        ? state.activeTabId
        : worktreeId
          ? (state?.activeTabIdByWorktree?.[worktreeId] ?? null)
          : null
    const manager = tabId ? window.__paneManagers?.get(tabId) : null
    const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
    if (!pane) {
      throw new Error('No active terminal pane for the recorded trace replay')
    }
    pane.terminal.onData((data) => target.__recordedTraceOnData.push(data))
  })
}

async function dispatchRecordedEvents(
  page: Page,
  recorded: readonly RecordedImeDomEvent[]
): Promise<void> {
  await page.evaluate((events: RecordedImeDomEvent[]) => {
    const textarea = document.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea:focus')
    if (!textarea) {
      throw new Error('xterm helper textarea is not focused')
    }
    for (const event of events) {
      // Apply recorded value/selection before dispatch: xterm reads textarea.value inside handlers, so applying afterward supplies stale state.
      if (event.value !== undefined) {
        textarea.value = event.value
      }
      if (event.selectionStart !== undefined && event.selectionEnd !== undefined) {
        textarea.setSelectionRange(event.selectionStart, event.selectionEnd)
      }
      // Replay Windows keypress as a keyboard event for textarea’s Enter default action; CompositionEvent would invent an unrecorded shape.
      if (event.type === 'keydown' || event.type === 'keyup' || event.type === 'keypress') {
        const keyboard = new KeyboardEvent(event.type, {
          key: event.key,
          code: event.code,
          isComposing: event.isComposing,
          bubbles: true,
          cancelable: true
        })
        Object.defineProperty(keyboard, 'keyCode', { value: event.keyCode })
        textarea.dispatchEvent(keyboard)
      } else if (event.type === 'input' || event.type === 'beforeinput') {
        textarea.dispatchEvent(
          new InputEvent(event.type, {
            bubbles: true,
            cancelable: event.type === 'beforeinput',
            composed: true,
            data: event.data ?? null,
            inputType: event.inputType ?? '',
            isComposing: event.isComposing
          })
        )
      } else {
        textarea.dispatchEvent(
          new CompositionEvent(event.type, {
            bubbles: true,
            data: event.data ?? ''
          })
        )
      }
    }
  }, recorded as RecordedImeDomEvent[])
}

// Fuse compositionend with its immediate beforeinput/input tail, matching Chromium’s single-task commit.
// A CDP task boundary lets xterm’s deferred finalizer read before IBus’s empty compositionend is followed by insertText, swallowing syllables.
// Keep update round-trips separate so deferred positioning runs before geometry samples.
function nextRecordedEventGroup(
  dom: readonly RecordedImeDomEvent[],
  start: number
): RecordedImeDomEvent[] {
  const group = [dom[start]]
  if (dom[start].type !== 'compositionend') {
    return group
  }
  for (let index = start + 1; index < dom.length; index += 1) {
    if (dom[index].type !== 'input' && dom[index].type !== 'beforeinput') {
      break
    }
    group.push(dom[index])
  }
  return group
}

export async function replayRecordedImeDomTrace(
  page: Page,
  trace: RecordedImeDomTrace
): Promise<RecordedTraceReplay> {
  await startRecordedTraceOnDataCapture(page)

  const samples: ReplayedCompositionSample[] = []
  let compositionOpen = false

  for (let index = 0; index < trace.dom.length;) {
    const group = nextRecordedEventGroup(trace.dom, index)
    const recorded = group[0]
    await dispatchRecordedEvents(page, group)
    index += group.length
    if (!COMPOSITION_EVENT_TYPES.has(recorded.type)) {
      continue
    }
    if (recorded.type === 'compositionstart') {
      compositionOpen = true
    }
    samples.push({
      index: index - group.length,
      type: recorded.type,
      data: recorded.data ?? '',
      compositionOpen,
      overlay: await samplePreeditOverlay(page)
    })
    if (recorded.type === 'compositionend') {
      compositionOpen = false
    }
  }

  const onData = await page.evaluate(() =>
    ((window as unknown as { __recordedTraceOnData?: string[] }).__recordedTraceOnData ?? []).join(
      ''
    )
  )
  return { samples, onData }
}
