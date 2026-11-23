export type ClickUpTokenDialogConnectState = 'idle' | 'connecting' | 'error'

export type ClickUpTokenDialogState = {
  tokenDraft: string
  connectState: ClickUpTokenDialogConnectState
  connectError: string | null
}

export const CLOSED_CLICKUP_TOKEN_DIALOG_STATE: ClickUpTokenDialogState = Object.freeze({
  tokenDraft: '',
  connectState: 'idle',
  connectError: null
})

export function resolveClickUpTokenDialogState(
  state: ClickUpTokenDialogState,
  open: boolean
): ClickUpTokenDialogState {
  if (open) {
    return state
  }
  if (state.tokenDraft === '' && state.connectState === 'idle' && state.connectError === null) {
    return state
  }
  return CLOSED_CLICKUP_TOKEN_DIALOG_STATE
}
