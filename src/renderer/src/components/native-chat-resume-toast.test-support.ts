import type { Action } from 'sonner'
import { toast } from 'sonner'
import { vi } from 'vitest'

const RESULT_ACTION_LABELS = new Set(['View chats', 'Review'])

type ClickedAction = { label: Action['label']; onClick(event?: unknown): void }

function isAction(value: unknown): value is Action {
  return typeof value === 'object' && value !== null && 'label' in value && 'onClick' in value
}

export function lastToastShow(): (() => void) | undefined {
  const action = vi.mocked(toast).mock.calls.at(-1)?.[1]?.action
  if (!isAction(action) || !RESULT_ACTION_LABELS.has(String(action.label))) {
    return undefined
  }
  const clicked: ClickedAction = action
  return () => clicked.onClick()
}
