import type { GitWorktreeInfo } from '../types'

/** Legacy removing markers do not prove the owner can resume cleanup after restart. */
export function isWorktreeRetiredByRemoval(
  row: Pick<GitWorktreeInfo, 'removing' | 'removalRecorded'>
): boolean {
  return row.removing === true && row.removalRecorded === true
}
