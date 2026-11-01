import { openFileInBrowserTab } from './file-preview'
import { resolveWorkspaceDocAddressTarget } from './workspace-doc-address-input'
import { selectWorkspaceSurface } from './workspace-surface-reveal'
import { useAppStore } from '@/store'

export function openHtmlFilePreview(params: {
  filePath: string
  worktreeId: string
  targetGroupId: string
}): void {
  const state = useAppStore.getState()
  const target = resolveWorkspaceDocAddressTarget(state, params.worktreeId, params.filePath)
  if (target.status === 'unsupported') {
    throw new Error(target.message)
  }
  const worktreeId =
    target.status === 'workspace-doc' ? target.docLocation.worktreeId : params.worktreeId
  if (state.activeWorktreeId !== worktreeId) {
    selectWorkspaceSurface(state, worktreeId)
  }
  const plan = openFileInBrowserTab({
    filePath: params.filePath,
    worktreeId,
    ...(worktreeId === params.worktreeId ? { targetGroupId: params.targetGroupId } : {})
  })
  if (plan.status === 'unsupported') {
    throw new Error(plan.message)
  }
}
