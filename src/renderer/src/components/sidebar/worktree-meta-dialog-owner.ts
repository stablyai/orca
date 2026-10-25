import { parseExecutionHostId } from '../../../../shared/execution-host'

export function getWorktreeMetaDialogOwner(state: {
  activeModal: string
  modalData: Record<string, unknown>
}): string | null {
  if (state.activeModal !== 'edit-meta') {
    return null
  }
  const { worktreeId, repoId, executionHostId } = state.modalData
  return JSON.stringify([
    typeof worktreeId === 'string' ? worktreeId : '',
    typeof repoId === 'string' ? repoId : null,
    typeof executionHostId === 'string' ? (parseExecutionHostId(executionHostId)?.id ?? null) : null
  ])
}
