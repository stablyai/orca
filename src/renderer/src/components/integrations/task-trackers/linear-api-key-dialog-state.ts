export type LinearApiKeyDialogConnectState = 'idle' | 'connecting' | 'error'

export type LinearApiKeyDialogState = {
  apiKeyDraft: string
  connectState: LinearApiKeyDialogConnectState
  connectError: string | null
}

export const CLOSED_LINEAR_API_KEY_DIALOG_STATE: LinearApiKeyDialogState = Object.freeze({
  apiKeyDraft: '',
  connectState: 'idle',
  connectError: null
})

export function createLinearApiKeyDialogState(): LinearApiKeyDialogState {
  return CLOSED_LINEAR_API_KEY_DIALOG_STATE
}

export function resolveLinearApiKeyDialogState(
  state: LinearApiKeyDialogState,
  open: boolean
): LinearApiKeyDialogState {
  if (open) {
    return state
  }
  if (state.apiKeyDraft === '' && state.connectState === 'idle' && state.connectError === null) {
    return state
  }
  return CLOSED_LINEAR_API_KEY_DIALOG_STATE
}
