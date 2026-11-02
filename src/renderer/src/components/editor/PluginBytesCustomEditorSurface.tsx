import React, { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { translate } from '@/i18n/i18n'
import { basename } from '@/lib/path'
import { readRuntimeFileBytes } from '@/runtime/runtime-paged-file-read'
import type { ActivePluginCustomEditor } from '@/store/plugin-custom-editors'
import { CUSTOM_EDITOR_DOCUMENT_MAX_BYTES } from '../../../../shared/plugins/frames/plugin-custom-editor-bridge'
import { matchPluginFile } from '../../../../shared/plugins/contributions/plugin-file-match'
import { fileTypeOfPath } from '../../../../shared/plugins/contributions/plugin-file-type'
import { formatBytes } from '../status-bar/workspace-space-format'
import { Button } from '../ui/button'
import type { OpenFile } from '@/store/slices/editor'
import type { FileContent } from './editor-panel-content-types'
import PluginCustomEditorFrame from './PluginCustomEditorFrame'
import { ExternalFileChangeBanner } from './ExternalFileChangeBanner'
import {
  editorBytesDocument,
  editorBytesEdits,
  hasEditorBytesDraft,
  loadEditorBytes,
  releaseEditorBytes,
  retainEditorBytes,
  setEditorBytesDraft,
  sha256Hex,
  subscribeEditorBytes
} from './editor-bytes-documents'

type BytesState =
  | { status: 'ok' }
  | { status: 'too_large'; size: number }
  | { status: 'unsupported' }
  | { status: 'error'; message: string }

const noopContentChange = (_content: string): void => {}

function SurfaceMessage({
  children,
  onRetry
}: {
  children: React.ReactNode
  onRetry?: () => void
}): React.JSX.Element {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center text-sm text-muted-foreground">
      <p className="max-w-md">{children}</p>
      {onRetry ? (
        <Button type="button" size="sm" variant="outline" onClick={onRetry}>
          {translate('auto.components.editor.PluginBytesCustomEditorSurface.retry', 'Retry')}
        </Button>
      ) : null}
    </div>
  )
}

/**
 * A bytes editor: Orca pages the file from the host that owns it (local, SSH or a paired runtime),
 * caps its size, and hands the frame only the bytes, never a path. Its edits replace the whole
 * document and save through the tab's save pipeline.
 */
export default function PluginBytesCustomEditorSurface({
  editor,
  file,
  fileContent,
  onSave,
  reloadContent
}: {
  editor: ActivePluginCustomEditor
  file: OpenFile
  fileContent: FileContent
  onSave: (content: string) => Promise<boolean>
  reloadContent: (file: OpenFile) => void
}): React.JSX.Element {
  const [state, setState] = useState<BytesState>({ status: 'ok' })
  const [attempt, setAttempt] = useState(0)
  const { id: fileId, filePath } = file
  const match = matchPluginFile(filePath, editor)
  const fileType =
    match?.by === 'extension' ? match.extension.slice(1) : (fileTypeOfPath(filePath) ?? '')
  const source = fileContent.byteSource
  // Why the object: every reload (an outside change included) lands as a new FileContent.
  const loadKey = fileContent.isStale ? null : fileContent
  const bytesDocument = useSyncExternalStore(subscribeEditorBytes, () =>
    editorBytesDocument(fileId)
  )
  const onBytesChange = useCallback(
    (next: Parameters<typeof setEditorBytesDraft>[1]) => setEditorBytesDraft(fileId, next),
    [fileId]
  )
  useEffect(() => {
    retainEditorBytes(fileId)
    return () => releaseEditorBytes(fileId)
  }, [fileId])

  useEffect(() => {
    // Unsaved bytes keep the baseline they were made against; rereading would hide a conflict.
    if (!loadKey || hasEditorBytesDraft(fileId)) {
      return
    }
    if (!source) {
      setState({ status: 'unsupported' })
      return
    }
    let cancelled = false
    const editsAtRead = editorBytesEdits(fileId)
    readRuntimeFileBytes(source, CUSTOM_EDITOR_DOCUMENT_MAX_BYTES)
      .then(async (read) => {
        if (cancelled) {
          return
        }
        if (read.kind === 'ok') {
          const sha256 = await sha256Hex(read.bytes)
          if (!cancelled) {
            loadEditorBytes(fileId, { bytes: read.bytes, fileType }, sha256, editsAtRead)
            setState({ status: 'ok' })
          }
        } else if (read.kind === 'too_large') {
          setState({ status: 'too_large', size: read.size })
        } else {
          setState({ status: 'unsupported' })
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setState({ status: 'error', message: error instanceof Error ? error.message : '' })
        }
      })
    return () => {
      cancelled = true
    }
  }, [loadKey, source, fileType, attempt, fileId])

  const name = basename(filePath)
  if (state.status === 'too_large') {
    return (
      <SurfaceMessage>
        {translate(
          'auto.components.editor.PluginBytesCustomEditorSurface.tooLarge',
          '{{value0}} is too large to open in {{value1}} ({{value2}}; the limit is {{value3}}).',
          {
            value0: name,
            value1: editor.title,
            value2: formatBytes(state.size),
            value3: formatBytes(CUSTOM_EDITOR_DOCUMENT_MAX_BYTES)
          }
        )}
      </SurfaceMessage>
    )
  }
  if (state.status === 'unsupported') {
    return (
      <SurfaceMessage>
        {translate(
          'auto.components.editor.PluginBytesCustomEditorSurface.unsupported',
          "{{value0}} can't read this file from where it is stored. Update the Orca server that hosts it, or switch to Source.",
          { value0: editor.title }
        )}
      </SurfaceMessage>
    )
  }
  if (state.status === 'error') {
    return (
      <SurfaceMessage onRetry={() => setAttempt((current) => current + 1)}>
        {translate(
          'auto.components.editor.PluginBytesCustomEditorSurface.readFailed',
          "{{value0}} couldn't be read for {{value1}}. {{value2}}",
          { value0: name, value1: editor.title, value2: state.message }
        )}
      </SurfaceMessage>
    )
  }
  return (
    <div className="flex h-full min-h-0 flex-col">
      {file.externalMutation === 'changed' ? (
        <ExternalFileChangeBanner
          file={file}
          currentContent=""
          reloadContent={reloadContent}
          binary
        />
      ) : null}
      <div className="min-h-0 flex-1">
        <PluginCustomEditorFrame
          editor={editor}
          fileId={fileId}
          content=""
          readOnly={file.readOnly === true}
          onContentChange={noopContentChange}
          onSave={onSave}
          binaryDocument={bytesDocument}
          onBytesChange={onBytesChange}
        />
      </div>
    </div>
  )
}
