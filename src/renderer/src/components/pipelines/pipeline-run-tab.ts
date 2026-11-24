import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import type { PipelineWorkspace } from './use-pipeline-workspace'

export function pipelineRunTabAddress(workspace: PipelineWorkspace) {
  return `pipeline-run:${encodeURIComponent(workspace.instanceId)}:${encodeURIComponent(workspace.pipeline.runId)}`
}

export function openPipelineRunTab(workspace: PipelineWorkspace) {
  const state = useAppStore.getState()
  const address = pipelineRunTabAddress(workspace)
  const existing = state.unifiedTabsByWorktree?.[workspace.id]?.find(
    (tab) => tab.entityId === address
  )
  if (
    existing &&
    state.openFiles.some((file) => file.id === address && file.mode === 'pipeline-run')
  ) {
    state.activateTab(existing.id, { worktreeId: workspace.id })
    return
  }
  state.openFile(
    {
      filePath: address,
      relativePath: translate('pipelines.execution', 'Pipeline run'),
      worktreeId: workspace.id,
      runtimeEnvironmentId: null,
      language: 'plaintext',
      readOnly: true,
      mode: 'pipeline-run'
    },
    { preview: false, suppressActiveRuntimeFallback: true }
  )
}
