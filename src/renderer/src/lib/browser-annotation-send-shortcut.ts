import {
  isEditableKeyboardTarget,
  isEditorSurfaceKeyboardTarget
} from '@/components/browser-pane/host-guest/browser-keyboard'
import type { PhysicalModifierToken } from '../../../shared/keybindings'

type SendRequest = { target: EventTarget | null; browserPageId?: string }
type SendResult = 'opened' | 'empty' | null
const handlers = new Set<(request: SendRequest) => SendResult>()

export function registerBrowserAnnotationSendShortcut(
  handler: (request: SendRequest) => SendResult
): () => void {
  handlers.add(handler)
  return () => {
    handlers.delete(handler)
  }
}

export function requestBrowserAnnotationSendMenu(request: SendRequest): SendResult {
  for (const handler of handlers) {
    const result = handler(request)
    if (result !== null) {
      return result
    }
  }
  return null
}

export function routeSendNotesShortcut(
  request: SendRequest
): 'opened' | 'review-notes' | 'ignored' {
  // Why: review notes are written in editor surfaces, so they keep the action there.
  if (isEditorSurfaceKeyboardTarget(request.target)) {
    return 'review-notes'
  }
  if (isEditableKeyboardTarget(request.target)) {
    return 'ignored'
  }
  const result = requestBrowserAnnotationSendMenu(request)
  if (result === 'opened') {
    return 'opened'
  }
  return result === 'empty' || request.browserPageId ? 'ignored' : 'review-notes'
}

const PHYSICAL_MODIFIERS: readonly unknown[] = [
  'Cmd',
  'Ctrl',
  'Alt',
  'Shift'
] satisfies PhysicalModifierToken[]

function isPhysicalModifier(value: unknown): value is PhysicalModifierToken {
  return PHYSICAL_MODIFIERS.includes(value)
}

/** Reads the fields the guest bridge adds to a replayed keydown. */
export function readGuestShortcutReplayFields(event: KeyboardEvent): {
  browserPageId?: string
  doubleTapModifier?: PhysicalModifierToken
} {
  return {
    browserPageId:
      'browserPageId' in event && typeof event.browserPageId === 'string'
        ? event.browserPageId
        : undefined,
    doubleTapModifier:
      'doubleTapModifier' in event && isPhysicalModifier(event.doubleTapModifier)
        ? event.doubleTapModifier
        : undefined
  }
}
