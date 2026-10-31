import {
  latestSessionTabsSnapshotByWorktree,
  latestReceivedSessionTabsSnapshotByWorktree,
  replayableSessionTabsSnapshotByWorktree,
  sessionTabsPublicationEpochHistoryByWorktree,
  sessionTabsRemovalWatermarkByWorktree,
  nextReceivedSessionTabsFrame,
  sessionTabsFreshnessKey
} from './state'

/** Fence this literal address before releasing its live view; sibling streams keep their own receipts. */
export function retireWebSessionTabsSourceAddress(
  environmentId: string,
  workspaceId: string
): void {
  const key = sessionTabsFreshnessKey(environmentId, workspaceId)
  const history = sessionTabsPublicationEpochHistoryByWorktree.get(key)
  const epoch = history?.current ?? latestSessionTabsSnapshotByWorktree.get(key)?.publicationEpoch
  const receivedFrame = nextReceivedSessionTabsFrame()
  sessionTabsRemovalWatermarkByWorktree.set(key, receivedFrame)
  latestReceivedSessionTabsSnapshotByWorktree.set(key, {
    receivedFrame,
    publicationEpoch: epoch ?? '',
    snapshotVersion: 0
  })
  if (epoch) {
    sessionTabsPublicationEpochHistoryByWorktree.set(key, {
      current: null,
      retired: [...new Set([...(history?.retired ?? []), epoch])].slice(-8)
    })
  }
  latestSessionTabsSnapshotByWorktree.delete(key)
  replayableSessionTabsSnapshotByWorktree.delete(key)
}
