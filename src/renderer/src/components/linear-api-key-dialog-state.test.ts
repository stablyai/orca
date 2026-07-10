import { describe, expect, it } from 'vitest'
import {
  CLOSED_LINEAR_API_KEY_DIALOG_STATE,
  resolveLinearApiKeyDialogState,
  type LinearApiKeyDialogState
} from './linear-api-key-dialog-state'

describe('resolveLinearApiKeyDialogState', () => {
  it('preserves draft and error state while the dialog is open', () => {
    const state: LinearApiKeyDialogState = {
      apiKeyDraft: 'lin_api_key',
      connectState: 'error',
      connectError: 'Nope'
    }

    expect(resolveLinearApiKeyDialogState(state, true)).toBe(state)
  })

  it('preserves identity for an already-reset closed dialog', () => {
    expect(resolveLinearApiKeyDialogState(CLOSED_LINEAR_API_KEY_DIALOG_STATE, false)).toBe(
      CLOSED_LINEAR_API_KEY_DIALOG_STATE
    )
  })

  it('resets draft and connection state when the dialog is closed', () => {
    const state: LinearApiKeyDialogState = {
      apiKeyDraft: 'lin_api_key',
      connectState: 'connecting',
      connectError: 'Previous error'
    }

    expect(resolveLinearApiKeyDialogState(state, false)).toEqual(CLOSED_LINEAR_API_KEY_DIALOG_STATE)
  })
})
