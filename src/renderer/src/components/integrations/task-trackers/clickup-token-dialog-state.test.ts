import { describe, expect, it } from 'vitest'
import {
  closedClickUpTokenDialogState,
  resolveClickUpTokenDialogState,
  type ClickUpTokenDialogState
} from './clickup-token-dialog-state'

const typedForLocal: ClickUpTokenDialogState = {
  ownerKey: 'local',
  tokenDraft: 'pk_secret',
  connectState: 'error',
  connectError: 'Invalid token'
}

describe('resolveClickUpTokenDialogState', () => {
  it('keeps the draft and error while the owner stays the same and the dialog is open', () => {
    expect(resolveClickUpTokenDialogState(typedForLocal, true, 'local')).toBe(typedForLocal)
  })

  it('resets the draft and error when the owner changes while the dialog is open', () => {
    expect(resolveClickUpTokenDialogState(typedForLocal, true, 'runtime:env-1')).toEqual(
      closedClickUpTokenDialogState('runtime:env-1')
    )
  })

  it('resets a draft left behind by a closed dialog', () => {
    expect(resolveClickUpTokenDialogState(typedForLocal, false, 'local')).toEqual(
      closedClickUpTokenDialogState('local')
    )
  })

  it('keeps an already blank closed state as is', () => {
    const closed = closedClickUpTokenDialogState('local')
    expect(resolveClickUpTokenDialogState(closed, false, 'local')).toBe(closed)
  })
})
