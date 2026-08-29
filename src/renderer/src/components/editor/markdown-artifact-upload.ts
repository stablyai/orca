import type { ArtifactWriteRequest } from '../../../../shared/artifacts'
import { sshArtifactSourceKey } from '../../../../shared/artifact-cli-bridge'
import { parseExecutionHostId } from '../../../../shared/execution-host'
import { basename } from '@/lib/path'
import { useAppStore } from '@/store'
import type { OpenFile } from '@/store/slices/editor'
import { flushPendingEditorChange } from './editor-pending-flush'

export function markdownArtifactSourceKey(file: OpenFile): string {
  const route = file.operationProvenance?.generation.route
  const host = parseExecutionHostId(route?.executionHostId)
  if (host?.kind === 'ssh') {
    return sshArtifactSourceKey(host.targetId, file.filePath)
  }
  if (file.externalSshTargetId) {
    return sshArtifactSourceKey(file.externalSshTargetId, file.filePath)
  }
  if (route && (route.runtimeEnvironmentId || route.executionHostId !== 'local')) {
    return JSON.stringify([
      'editor',
      route.runtimeEnvironmentId ?? null,
      route.executionHostId,
      file.filePath
    ])
  }
  if (file.runtimeEnvironmentId) {
    return JSON.stringify(['editor', file.runtimeEnvironmentId ?? null, 'remote', file.filePath])
  }
  return file.filePath
}

export function createMarkdownArtifactRequest(
  file: OpenFile,
  content: string
): ArtifactWriteRequest {
  return {
    sourceKey: markdownArtifactSourceKey(file),
    content,
    contentType: 'text/markdown',
    fileName: basename(file.filePath)
  }
}

export function createCurrentMarkdownArtifactRequest(
  file: OpenFile,
  contentFileId: string,
  fallbackContent: string
): ArtifactWriteRequest {
  flushPendingEditorChange(contentFileId)
  const content = useAppStore.getState().editorDrafts[contentFileId] ?? fallbackContent
  return createMarkdownArtifactRequest(file, content)
}
