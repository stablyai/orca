import { useEffect, useRef, useState } from 'react'
import type { WorkspaceSurface } from '../../../../shared/maestro-workspace-canvas'
import { parseWorkspaceKey } from '../../../../shared/workspace-scope'
import type { RuntimeClientTarget } from '@/runtime/runtime-client-target'
import {
  readRuntimeMaestroAnnotation,
  readRuntimeMaestroContent,
  readRuntimeMaestroDiff
} from '@/runtime/runtime-maestro-workspace-client'
import { translate } from '@/i18n/i18n'
import { MaestroWorkspaceMiniMarkdownEditor } from './MaestroWorkspaceMiniMarkdownEditor'

type Preview = { content: string; revision: string; source: string }

export function MaestroWorkspaceContentPreview({
  target,
  surface,
  onUpdateAnnotationContent
}: {
  target: RuntimeClientTarget
  surface: WorkspaceSurface
  onUpdateAnnotationContent?: (content: string) => void
}): React.JSX.Element {
  const [preview, setPreview] = useState<Preview | null>(null)
  const [unavailable, setUnavailable] = useState(false)
  const workspace = parseWorkspaceKey(surface.id.workspace_key)
  const worktreeId =
    workspace?.type === 'folder' ? workspace.folderWorkspaceId : workspace?.worktreeId
  const binding = surface.binding.kind === 'content' ? surface.binding : null
  const executionHostId = surface.id.execution_host_id
  const workspaceKey = surface.id.workspace_key
  const unifiedTabId = surface.id.unified_tab_id

  // Layout mutations rebuild equivalent objects, so primitive identity prevents reloads on Fit.
  const latestTarget = useRef(target)
  latestTarget.current = target
  const targetKey = target.kind === 'environment' ? `environment:${target.environmentId}` : 'local'
  const hasAnnotation = binding?.annotation != null
  const modelRevision = binding?.model_revision ?? ''
  const sourceMode = binding?.source?.mode ?? null
  const sourceRelativePath = binding?.source?.relative_path ?? null
  const sourceDiffSource = binding?.source?.diff_source ?? null
  const sourceIsDirty = binding?.source?.is_dirty ?? false

  useEffect(() => {
    let active = true
    setPreview(null)
    setUnavailable(false)
    if (!worktreeId || sourceRelativePath === null) {
      setUnavailable(true)
      return
    }
    const activeTarget = latestTarget.current
    const load = async (): Promise<Preview> => {
      if (hasAnnotation) {
        const result = await readRuntimeMaestroAnnotation(activeTarget, worktreeId, unifiedTabId)
        return { content: result.content, revision: result.version, source: result.source }
      }
      if (sourceMode === 'diff') {
        const result = await readRuntimeMaestroDiff(
          activeTarget,
          worktreeId,
          sourceRelativePath,
          sourceDiffSource === 'staged'
        )
        if (result.kind === 'binary') {
          throw new Error('binary_diff_unavailable')
        }
        return {
          content: `--- Original\n${result.originalContent}\n+++ Modified\n${result.modifiedContent}`,
          revision: modelRevision,
          source: sourceDiffSource ?? 'unstaged'
        }
      }
      const result = await readRuntimeMaestroContent(
        activeTarget,
        {
          execution_host_id: executionHostId,
          workspace_key: workspaceKey
        },
        {
          execution_host_id: executionHostId,
          workspace_key: workspaceKey,
          unified_tab_id: unifiedTabId
        }
      )
      return {
        content: result.content,
        revision: result.modelRevision,
        source: sourceIsDirty ? 'live draft' : 'file'
      }
    }
    void load().then(
      (result) => active && setPreview(result),
      () => active && setUnavailable(true)
    )
    return () => {
      active = false
    }
  }, [
    executionHostId,
    hasAnnotation,
    modelRevision,
    sourceDiffSource,
    sourceIsDirty,
    sourceMode,
    sourceRelativePath,
    targetKey,
    unifiedTabId,
    workspaceKey,
    worktreeId
  ])

  if (preview && binding) {
    return (
      <div className="flex size-full min-h-0 flex-col overflow-hidden bg-editor-surface">
        {binding.annotation && onUpdateAnnotationContent ? (
          <MaestroWorkspaceMiniMarkdownEditor
            content={preview.content}
            onSave={onUpdateAnnotationContent}
          />
        ) : (
          <pre className="scrollbar-sleek min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words p-3 font-mono text-xs leading-5 text-foreground">
            {preview.content}
          </pre>
        )}
        <p className="shrink-0 border-t border-border/50 px-3 py-1.5 text-[10px] text-muted-foreground">
          {preview.source}{' '}
          {translate(
            'auto.components.maestro.MaestroWorkspaceContentPreview.6ecef4bd09',
            '· revision'
          )}{' '}
          {preview.revision}
        </p>
      </div>
    )
  }
  return (
    <div className="flex size-full items-center justify-center bg-editor-surface p-3 text-center text-xs text-muted-foreground">
      {unavailable
        ? translate(
            'auto.components.maestro.MaestroWorkspaceContentPreview.803e2cdc3b',
            'Exact content preview is unavailable.'
          )
        : translate(
            'auto.components.maestro.MaestroWorkspaceContentPreview.caadff40f7',
            'Loading exact content…'
          )}
    </div>
  )
}
