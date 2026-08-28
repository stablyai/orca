import type { EditorGet, EditorSet } from '../types/editor-set-get'
import type { EditorSlice } from '../types/editor-slice'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { detectLanguage } from '@/lib/language-detect'
import { openHttpLink, type HttpLinkSourceOwner } from '@/lib/http-link-routing'
import { getConnectionIdForFileFromState } from '@/lib/connection-owner-resolution'
import { isLocalPathOpenBlocked, showLocalPathOpenBlockedToast } from '@/lib/local-path-open-guard'
import { resolveMarkdownLinkTarget } from '@/components/editor/markdown-internal-links'
import { settingsForRuntimeOwner } from '@/runtime/runtime-rpc-client'
import { statRuntimePath } from '@/runtime/runtime-file-client'
import { getOpenedEditFileIdAfterOpen } from '../file-ids/editor-file-ids'
import { scheduleEditorLineReveal } from '../focus/editor-focus-reveal'

export function createMarkdownLinkAction(
  _set: EditorSet,
  get: EditorGet
): Pick<EditorSlice, 'activateMarkdownLink'> {
  return {
    activateMarkdownLink: async (rawHref, ctx) => {
      const initialState = get()
      let inferredRuntimeEnvironmentId: string | null | undefined
      if (!ctx.sourceOwner && ctx.runtimeEnvironmentId === undefined) {
        const inferredRuntimeOwners = new Set(
          initialState.openFiles
            .filter(
              (file) => file.filePath === ctx.sourceFilePath && file.worktreeId === ctx.worktreeId
            )
            .map((file) => file.runtimeEnvironmentId?.trim() || null)
        )
        if (inferredRuntimeOwners.size > 1) {
          return
        }
        inferredRuntimeEnvironmentId =
          inferredRuntimeOwners.size === 1 ? [...inferredRuntimeOwners][0] : undefined
      }
      const sourceRuntimeEnvironmentId =
        ctx.sourceOwner?.kind === 'runtime'
          ? ctx.sourceOwner.runtimeEnvironmentId
          : ctx.sourceOwner
            ? null
            : ctx.runtimeEnvironmentId !== undefined
              ? ctx.runtimeEnvironmentId
              : inferredRuntimeEnvironmentId
      const runtimeOwnerId = sourceRuntimeEnvironmentId?.trim() || null
      const sourceSettings = settingsForRuntimeOwner(initialState.settings, runtimeOwnerId)
      const resolvedConnectionId =
        ctx.sourceOwner || runtimeOwnerId
          ? undefined
          : getConnectionIdForFileFromState(initialState, ctx.worktreeId, ctx.sourceFilePath)
      const sourceOwner: HttpLinkSourceOwner =
        ctx.sourceOwner ??
        (runtimeOwnerId
          ? { kind: 'runtime', runtimeEnvironmentId: runtimeOwnerId }
          : resolvedConnectionId === undefined
            ? { kind: 'unknown' }
            : resolvedConnectionId === null
              ? { kind: 'local' }
              : { kind: 'ssh', connectionId: resolvedConnectionId })
      if (sourceOwner.kind === 'unknown') {
        return
      }
      const sourceConnectionId = sourceOwner.kind === 'ssh' ? sourceOwner.connectionId : undefined
      const fileContext = {
        settings: sourceSettings,
        worktreeId: ctx.worktreeId,
        worktreePath: ctx.worktreeRoot,
        connectionId: sourceConnectionId
      }
      const target = resolveMarkdownLinkTarget(rawHref, ctx.sourceFilePath, ctx.worktreeRoot)
      if (!target) {
        return
      }
      if (target.kind === 'anchor') {
        return
      }
      if (target.kind === 'external') {
        openHttpLink(target.url, { worktreeId: ctx.worktreeId, sourceOwner })
        return
      }
      if (target.kind === 'file') {
        const { line, column } = target
        if (target.relativePath === undefined) {
          if (isLocalPathOpenBlocked(sourceSettings, { connectionId: sourceConnectionId })) {
            // Why: a file:// link outside the worktree is client-local; remote runtime/SSH editors must not treat server paths as client paths.
            showLocalPathOpenBlockedToast()
            return
          }
          // Why: markdown file:// links need the same user-gesture authorization terminal links get, so external paths (e.g. /tmp screenshots) can open in Orca.
          await window.api.fs.authorizeExternalPath({ targetPath: target.absolutePath })
        } else {
          let stats: { isDirectory: boolean }
          try {
            stats = await statRuntimePath(fileContext, target.absolutePath)
          } catch {
            toast.error(
              translate('auto.store.slices.editor.f2e00db373', 'File not found: {{value0}}', {
                value0: target.relativePath
              })
            )
            return
          }
          if (stats.isDirectory) {
            toast.error(
              translate(
                'auto.store.slices.editor.51f15c37d3',
                'Cannot open directory: {{value0}}',
                {
                  value0: target.relativePath
                }
              )
            )
            return
          }
        }

        get().openFile(
          {
            filePath: target.absolutePath,
            relativePath: target.relativePath ?? target.absolutePath,
            worktreeId: ctx.worktreeId,
            runtimeEnvironmentId: sourceRuntimeEnvironmentId,
            language: detectLanguage(target.absolutePath),
            mode: 'edit'
          },
          {
            preview: true,
            targetGroupId: get().activeGroupIdByWorktree?.[ctx.worktreeId],
            recordReplacedPreview: true
          }
        )
        if (line !== undefined) {
          const fileId = getOpenedEditFileIdAfterOpen(get(), target.absolutePath, ctx.worktreeId)
          scheduleEditorLineReveal(get, target.absolutePath, line, column, fileId)
        }
        return
      }

      // target.kind === 'markdown'
      const { absolutePath, relativePath, line, column } = target
      let stats: { isDirectory: boolean }
      try {
        stats = await statRuntimePath(fileContext, absolutePath)
      } catch {
        toast.error(
          translate('auto.store.slices.editor.f2e00db373', 'File not found: {{value0}}', {
            value0: relativePath
          })
        )
        return
      }
      if (stats.isDirectory) {
        toast.error(
          translate('auto.store.slices.editor.51f15c37d3', 'Cannot open directory: {{value0}}', {
            value0: relativePath
          })
        )
        return
      }

      get().openFile(
        {
          filePath: absolutePath,
          relativePath,
          worktreeId: ctx.worktreeId,
          runtimeEnvironmentId: sourceRuntimeEnvironmentId,
          language: 'markdown',
          mode: 'edit'
        },
        {
          preview: true,
          targetGroupId: get().activeGroupIdByWorktree?.[ctx.worktreeId],
          recordReplacedPreview: true
        }
      )

      if (line !== undefined) {
        const fileId = getOpenedEditFileIdAfterOpen(get(), absolutePath, ctx.worktreeId)
        // Why: MonacoEditor drops the reveal if the file stays in rich mode; switch to source using the resolved owner-qualified id.
        get().setMarkdownViewMode(fileId, 'source')
        scheduleEditorLineReveal(get, absolutePath, line, column, fileId)
      }
    }
  }
}
