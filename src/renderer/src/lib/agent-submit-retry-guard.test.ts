import { describe, expect, it, vi } from 'vitest'
import type { AgentStatusEntry } from '../../../shared/agent-status-types'
import { isSubmitRetryStillOwed } from './agent-submit-retry-guard'

vi.mock('@/store', () => ({ useAppStore: { getState: () => ({}) } }))
vi.mock('@/runtime/runtime-terminal-inspection', () => ({ resolvePaneKeyForPtyId: () => null }))

function status(
  state: AgentStatusEntry['state'],
  turnStartedAt: number
): Pick<AgentStatusEntry, 'state' | 'stateStartedAt' | 'turnStartedAt'> {
  return { state, stateStartedAt: turnStartedAt, turnStartedAt }
}

describe('whether the blind retry Enter is still owed', () => {
  it.each([
    ['no status reported (hooks off)', undefined, undefined, true],
    ['an idle pane', status('done', 1), status('done', 1), true],
    ['a turn that was already running', status('working', 5), status('working', 5), true],
    ['a turn started after the first Enter', status('done', 1), status('working', 9), false],
    ['a new turn replacing a running one', status('working', 5), status('working', 9), false],
    ['a permission prompt', status('done', 1), status('waiting', 9), false],
    ['a blocked pane', undefined, status('blocked', 9), false]
  ])('%s', (_, before, now, owed) => {
    expect(isSubmitRetryStillOwed(before, now)).toBe(owed)
  })
})
