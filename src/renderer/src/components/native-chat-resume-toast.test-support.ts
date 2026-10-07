import type { Action } from 'sonner'
import { toast } from 'sonner'
import { vi } from 'vitest'

/** A toast action as a click sees it; no Show handler reads the event. */
type ClickedAction = { label: Action['label']; onClick(event?: unknown): void }

function isAction(value: unknown): value is Action {
  return typeof value === 'object' && value !== null && 'label' in value && 'onClick' in value
}

/** The Show action on the last toast (sonner mocked), as a click; undefined when it has none. */
export function lastToastShow(): (() => void) | undefined {
  const action = vi.mocked(toast).mock.calls.at(-1)?.[1]?.action
  if (!isAction(action) || action.label !== 'Show') {
    return undefined
  }
  const clicked: ClickedAction = action
  return () => clicked.onClick()
}
