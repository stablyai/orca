// Server frames can adopt a desktop-staged page and replace its row (L284); absence then means create completed, not user close.

const handedOver = new Map<string, string>()

export function noteStagedBrowserTabHandedToFrames(
  stagedWorkspaceId: string,
  remotePageId: string
): void {
  handedOver.set(stagedWorkspaceId, remotePageId)
}

export function wasStagedBrowserTabHandedToFrames(
  stagedWorkspaceId: string,
  remotePageId: string
): boolean {
  return handedOver.get(stagedWorkspaceId) === remotePageId
}

export function forgetStagedBrowserTabHandover(stagedWorkspaceId: string): void {
  handedOver.delete(stagedWorkspaceId)
}

export function _resetStagedBrowserFrameHandoversForTests(): void {
  handedOver.clear()
}
