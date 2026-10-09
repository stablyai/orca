/** A rename with text pins the label; empty text returns it to automatic (branch-derived). */
export function displayNameUpdatePinsLabel(displayName: string | undefined): boolean {
  return Boolean(displayName?.trim())
}

export function displayNameUpdateMetadata(displayName: string | undefined) {
  return {
    displayNameIsPinned: displayNameUpdatePinsLabel(displayName),
    pendingFirstAgentMessageRename: false,
    firstAgentMessageRenameError: null
  }
}
