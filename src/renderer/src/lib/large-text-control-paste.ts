import { createTextControlRejectedResult } from './text-control-paste-diagnostics'
import {
  TEXT_CONTROL_PASTE_MAX_BYTES,
  pasteTextIntoTextControl,
  type TextControlPasteOptions,
  type TextControlPasteResult
} from './text-control-paste'
import {
  classifyTextControlPastePayloadOwnership,
  findOwnedPasteEventTextControlTarget
} from './text-control-paste-ownership'

export type LargeTextControlPasteResult =
  | { status: 'ignored'; reason: 'not-text-control' | 'empty' | 'small' | 'already-handled' }
  | { status: 'handled' }
  | { status: 'rejected'; reason: 'empty' | 'target-unavailable' | 'too-large' }
  | { status: 'cancelled'; reason: 'target-unavailable' }

export type LargeTextControlPasteOptions = Pick<
  TextControlPasteOptions,
  | 'chunkMaxBytes'
  | 'directMaxBytes'
  | 'maxBytes'
  | 'measureYieldAfterCodeUnits'
  | 'yieldToEventLoop'
  | 'now'
> & {
  onPasteResult?: (result: TextControlPasteResult) => void
}

function getNowMs(): number {
  return globalThis.performance?.now?.() ?? Date.now()
}

function getPlainTextFromPasteEvent(event: ClipboardEvent): string {
  return event.clipboardData?.getData('text/plain') ?? ''
}

export function findLargeTextControlPasteTarget(
  eventTarget: EventTarget | null,
  activeElement: Element | null = document.activeElement
): HTMLInputElement | HTMLTextAreaElement | null {
  if (!(eventTarget instanceof Element)) {
    return null
  }
  return findOwnedPasteEventTextControlTarget(eventTarget, activeElement)
}

export function handleLargeTextControlPasteEvent(
  event: ClipboardEvent,
  options: LargeTextControlPasteOptions = {}
): LargeTextControlPasteResult {
  const now = options.now ?? getNowMs
  const startedAtMs = now()
  if (event.defaultPrevented) {
    return { status: 'ignored', reason: 'already-handled' }
  }

  const target = findLargeTextControlPasteTarget(event.target)
  if (!target) {
    return { status: 'ignored', reason: 'not-text-control' }
  }

  const text = getPlainTextFromPasteEvent(event)
  if (!text) {
    return { status: 'ignored', reason: 'empty' }
  }

  const maxBytes = options.maxBytes ?? TEXT_CONTROL_PASTE_MAX_BYTES
  const ownership = classifyTextControlPastePayloadOwnership(text, {
    directMaxBytes: options.directMaxBytes,
    maxBytes
  })
  if (ownership.action === 'allow-native') {
    return { status: 'ignored', reason: 'small' }
  }

  event.preventDefault()
  event.stopPropagation()
  if (ownership.action === 'reject') {
    options.onPasteResult?.(
      createTextControlRejectedResult(
        'too-large',
        ownership.byteLength,
        'clipboard',
        now() - startedAtMs
      )
    )
    return { status: 'rejected', reason: 'too-large' }
  }
  // Why: browser-native insertion is one synchronous value mutation; large
  // text controls need Orca-owned chunking so the renderer can keep yielding.
  void pasteTextIntoTextControl(target, text, {
    source: 'clipboard',
    chunkMaxBytes: options.chunkMaxBytes,
    directMaxBytes: options.directMaxBytes,
    maxBytes,
    measureYieldAfterCodeUnits: options.measureYieldAfterCodeUnits,
    yieldToEventLoop: options.yieldToEventLoop,
    now: options.now,
    canContinue: (candidate) => candidate.ownerDocument.activeElement === candidate
  }).then(options.onPasteResult)

  return { status: 'handled' }
}

export function addLargeTextControlPasteListener(
  target: Pick<Document, 'addEventListener' | 'removeEventListener'>,
  options: LargeTextControlPasteOptions = {}
): () => void {
  const onPaste = (event: Event): void => {
    handleLargeTextControlPasteEvent(event as ClipboardEvent, options)
  }
  // Why: claim large input/textarea paste before component handlers synchronously
  // inspect the same clipboard payload or schedule stale target-specific work.
  target.addEventListener('paste', onPaste, { capture: true })
  return () => target.removeEventListener('paste', onPaste, { capture: true })
}
