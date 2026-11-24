export type ClickUpTokenDialogConnectState = 'idle' | 'connecting' | 'error'

export type ClickUpTokenDialogState = {
  /** The owner the draft and error below belong to; a token typed for one runtime is never sent to another. */
  ownerKey: string
  tokenDraft: string
  connectState: ClickUpTokenDialogConnectState
  connectError: string | null
}

export function closedClickUpTokenDialogState(ownerKey: string): ClickUpTokenDialogState {
  return { ownerKey, tokenDraft: '', connectState: 'idle', connectError: null }
}

export function resolveClickUpTokenDialogState(
  state: ClickUpTokenDialogState,
  open: boolean,
  ownerKey: string
): ClickUpTokenDialogState {
  if (state.ownerKey !== ownerKey) {
    return closedClickUpTokenDialogState(ownerKey)
  }
  if (open) {
    return state
  }
  if (state.tokenDraft === '' && state.connectState === 'idle' && state.connectError === null) {
    return state
  }
  return closedClickUpTokenDialogState(ownerKey)
}
