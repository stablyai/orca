import { useMemo, useSyncExternalStore } from 'react'
import { pipelineRunResource } from './pipeline-run-resource'
import type { PipelineRunScope } from './pipeline-run-read'
import { pipelineRetentionVersion, subscribePipelineRetention } from './pipeline-retention-events'

export function usePipelineRun(scope: PipelineRunScope) {
  const version = useSyncExternalStore(subscribePipelineRetention, pipelineRetentionVersion)
  const { projectId, workspaceInstanceId, runId } = scope
  const { resource } = useMemo(
    () => ({ version, resource: pipelineRunResource({ projectId, workspaceInstanceId, runId }) }),
    [projectId, workspaceInstanceId, runId, version]
  )
  const state = useSyncExternalStore(resource.subscribe, resource.snapshot)
  return { ...state, resource }
}
