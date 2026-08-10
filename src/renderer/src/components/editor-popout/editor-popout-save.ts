import type { EditorPopoutOpenRequest } from '../../../../shared/editor-popout'
import { readRuntimeFileContent, writeRuntimeFile } from '@/runtime/runtime-file-client'

export type EditorPopoutSaveResult =
  | { ok: true }
  | { ok: false; reason: 'binary' | 'external-change' }

export function readEditorPopoutDocument(request: EditorPopoutOpenRequest) {
  const { document, operationContext } = request
  return readRuntimeFileContent({
    settings: operationContext.settings,
    filePath: document.filePath,
    relativePath: document.relativePath,
    worktreeId: document.worktreeId,
    connectionId: operationContext.connectionId,
    expectedExternalSshTargetId: operationContext.expectedExternalSshTargetId
  })
}

export async function saveEditorPopoutDocument(
  request: EditorPopoutOpenRequest,
  content: string,
  savedContent: string
): Promise<EditorPopoutSaveResult> {
  const { document, operationContext } = request
  const disk = await readEditorPopoutDocument(request)
  if (disk.isBinary) {
    return { ok: false, reason: 'binary' }
  }
  if (disk.content !== savedContent) {
    return { ok: false, reason: 'external-change' }
  }
  if (content !== savedContent) {
    await writeRuntimeFile(operationContext, document.filePath, content)
  }
  return { ok: true }
}
