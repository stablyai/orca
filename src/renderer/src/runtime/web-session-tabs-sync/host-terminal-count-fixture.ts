import { rememberHostTerminalTabCount } from './tracking'

/** Records the host's answer that a worktree has no terminals, as its first session-tabs frame would. */
export function rememberEmptyHostAnswerForTests(environmentId: string, worktreeId: string): void {
  rememberHostTerminalTabCount(environmentId, {
    worktree: worktreeId,
    publicationEpoch: 'epoch-1',
    snapshotVersion: 1,
    activeGroupId: null,
    activeTabId: null,
    activeTabType: null,
    tabs: []
  })
}
