import type { ExecutionHostId } from '../../../../../shared/execution-host'

export type ComposerParentWorktreePickerProps = {
  repoId: string
  /** The child's destination host; parents on it nest as usual, others by a cross-machine link. */
  executionHostId?: ExecutionHostId | null
  projectId?: string | null
  value: string | null
  onChange: (id: string | null) => void
  disabled?: boolean
  /** When the active workspace is a folder, restrict candidates to that folder's subtree. */
  activeFolderWorkspaceId?: string | null
}

export type ParentWorktreeCandidateListProps = Omit<
  ComposerParentWorktreePickerProps,
  'onChange' | 'disabled' | 'activeFolderWorkspaceId'
> & {
  activeFolderWorkspaceId: string | null
  onSelect: (id: string | null) => void
}
