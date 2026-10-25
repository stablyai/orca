// A browser tab this desktop staged in a frame-drawn server workspace that the server's frames then
// drew as their own tab for the same page (ledger L284). The frames replace the staged rows, so the
// create must read their absence as done, not as the user's close.

/** Staged workspace id → the remote page the frames took over. */
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

/** The create settled: its record must not outlive it. */
export function forgetStagedBrowserTabHandover(stagedWorkspaceId: string): void {
  handedOver.delete(stagedWorkspaceId)
}

export function _resetStagedBrowserFrameHandoversForTests(): void {
  handedOver.clear()
}
