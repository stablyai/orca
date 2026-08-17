import { describe, expect, it } from 'vitest'
import { FLOATING_TERMINAL_WORKTREE_ID } from './constants'
import {
  assertValidTerminalMoveDestination,
  getTerminalMoveDestinationError
} from './terminal-move-destination'

describe('terminal move destination guards', () => {
  it('rejects the floating terminal and the current worktree', () => {
    expect(
      getTerminalMoveDestinationError('repo::/src', FLOATING_TERMINAL_WORKTREE_ID)
    ).toBe('destination_is_floating')
    expect(getTerminalMoveDestinationError('repo::/src', 'repo::/src')).toBe(
      'destination_same_as_source'
    )
    expect(getTerminalMoveDestinationError('repo::/src', 'repo::/dest')).toBeNull()
  })

  it('throws the closed error codes', () => {
    expect(() =>
      assertValidTerminalMoveDestination('repo::/src', FLOATING_TERMINAL_WORKTREE_ID)
    ).toThrow('destination_is_floating')
    expect(() => assertValidTerminalMoveDestination('repo::/src', 'repo::/src')).toThrow(
      'destination_same_as_source'
    )
  })
})
