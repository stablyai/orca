import type { GitStatusEntry } from '../../git/status/git-status-types'

/** A row a mounted Source Control panel displays, in display order. */
export type SourceControlVisibleRow = {
  key: string
  entry: GitStatusEntry
}
