import type { KeybindingActionId } from '../../../../shared/keybindings'

export type ShortcutActionIntentSignal = {
  actionId: KeybindingActionId
  requestId: number
}

type ShortcutActionIntentTarget = {
  intent?: string
  actionId?: KeybindingActionId
  [key: string]: unknown
}

export function isShortcutActionIntentTarget(
  target: ShortcutActionIntentTarget | null | undefined
): target is ShortcutActionIntentTarget & {
  intent: 'shortcut-action'
  actionId: KeybindingActionId
} {
  return target?.intent === 'shortcut-action' && target.actionId !== undefined
}

export function getShortcutActionIntentSignal(
  target: ShortcutActionIntentTarget,
  current: ShortcutActionIntentSignal | null
): ShortcutActionIntentSignal | null {
  if (!isShortcutActionIntentTarget(target)) {
    return null
  }
  return {
    actionId: target.actionId,
    requestId: (current?.requestId ?? 0) + 1
  }
}
