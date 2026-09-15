import type { KeybindingContext, TextEntryClaim } from '../../../shared/keybindings'
import { isEditableTarget } from './editable-target'

/**
 * What the focused element means for shortcut dispatch.
 *
 * `blocked` is the default for any editable element: app shortcuts stay suppressed
 * there exactly as before. A surface opts out of that by declaring
 * `data-keyboard-surface`, which states which gestures it actually owns and lets
 * everything else through.
 */
export type KeyboardShortcutSurface =
  | { kind: 'app' }
  | { kind: 'terminal' }
  | { kind: 'text-entry'; claim: TextEntryClaim }
  | { kind: 'blocked' }

export const KEYBOARD_SURFACE_ATTRIBUTE = 'data-keyboard-surface'

const DECLARED_CLAIMS: Record<string, TextEntryClaim> = {
  // A single line has no vertical caret movement and no formatting of its own.
  'text-field': { verticalCaret: false, richTextFormatting: false },
  'text-editor': { verticalCaret: true, richTextFormatting: false },
  'rich-text': { verticalCaret: true, richTextFormatting: true }
}

/** Input types whose arrow keys step a value instead of moving a caret. */
const VERTICAL_ARROW_INPUT_TYPES = new Set([
  'number',
  'range',
  'date',
  'datetime-local',
  'month',
  'time',
  'week'
])

/**
 * What the element itself owns regardless of the region it sits in, so a declared
 * region can never hand away a gesture the focused control actually needs.
 */
function inherentTextEntryClaim(target: HTMLElement): TextEntryClaim {
  if (target.isContentEditable) {
    return { verticalCaret: true, richTextFormatting: true }
  }
  const field = target.closest('input, textarea, select')
  if (field instanceof HTMLInputElement) {
    return {
      verticalCaret: VERTICAL_ARROW_INPUT_TYPES.has(field.type),
      richTextFormatting: false
    }
  }
  return { verticalCaret: field !== null, richTextFormatting: false }
}

const APP_SURFACE: KeyboardShortcutSurface = { kind: 'app' }
const TERMINAL_SURFACE: KeyboardShortcutSurface = { kind: 'terminal' }
const BLOCKED_SURFACE: KeyboardShortcutSurface = { kind: 'blocked' }

export function resolveKeyboardShortcutSurface(
  target: EventTarget | null
): KeyboardShortcutSurface {
  if (!(target instanceof HTMLElement)) {
    return APP_SURFACE
  }
  // Checked before editability because xterm's helper textarea is an input element
  // that must keep receiving app shortcuts.
  if (target.classList.contains('xterm-helper-textarea')) {
    return TERMINAL_SURFACE
  }
  if (!isEditableTarget(target)) {
    return APP_SURFACE
  }
  const declared = target.closest(`[${KEYBOARD_SURFACE_ATTRIBUTE}]`)
  const claim = declared
    ? DECLARED_CLAIMS[declared.getAttribute(KEYBOARD_SURFACE_ATTRIBUTE) ?? '']
    : undefined
  if (!claim) {
    return BLOCKED_SURFACE
  }
  const inherent = inherentTextEntryClaim(target)
  return {
    kind: 'text-entry',
    claim: {
      verticalCaret: claim.verticalCaret || inherent.verticalCaret,
      richTextFormatting: claim.richTextFormatting || inherent.richTextFormatting
    }
  }
}

export function keybindingContextForSurface(surface: KeyboardShortcutSurface): KeybindingContext {
  if (surface.kind === 'terminal') {
    return 'terminal'
  }
  return surface.kind === 'text-entry' ? 'text-entry' : 'app'
}

export function textEntryClaimForSurface(
  surface: KeyboardShortcutSurface
): TextEntryClaim | undefined {
  return surface.kind === 'text-entry' ? surface.claim : undefined
}
