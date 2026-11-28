import { RefreshCw } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import type { AppState } from '@/store/types'
import { isEditorReloadEligible } from '@/components/editor/external-changes/reload-from-disk/editor-reload-tab-state'
import { requestEditorReloadFromDisk } from '@/components/editor/external-changes/reload-from-disk/useEditorPanelReloadFromDisk'
import type { CmdJQuickAction } from './quick-actions'
import type { CmdJQuickActionContext } from './quick-action-context'

export const RELOAD_FILE_FROM_DISK_ACTION_ID = 'reload-file-from-disk'

/** The file of the active group's active tab, when it is an edit or Markdown preview tab that can reload. */
export function resolveActiveEditorReloadFileId(
  state: Pick<AppState, 'activeView' | 'groupsByWorktree' | 'unifiedTabsByWorktree' | 'openFiles'>,
  worktreeId: string | null,
  groupId: string | null
): string | null {
  if (state.activeView !== 'terminal' || !worktreeId || !groupId) {
    return null
  }
  const group = (state.groupsByWorktree?.[worktreeId] ?? []).find((entry) => entry.id === groupId)
  const tab = (state.unifiedTabsByWorktree?.[worktreeId] ?? []).find(
    (entry) => entry.id === group?.activeTabId && entry.groupId === groupId
  )
  if (tab?.contentType !== 'editor') {
    return null
  }
  const file = state.openFiles.find((entry) => entry.id === tab.entityId)
  return file && isEditorReloadEligible(file) ? file.id : null
}

function availability(ctx: CmdJQuickActionContext) {
  return ctx.activeEditorReloadFileId
    ? ({ available: true } as const)
    : // Hidden rather than explained: the palette filters out unavailable actions.
      ({ available: false, reason: 'no-active-group' } as const)
}

export function getEditorReloadQuickAction(): CmdJQuickAction {
  return {
    id: RELOAD_FILE_FROM_DISK_ACTION_ID,
    kind: 'action',
    title: translate('editor.reloadFromDisk.paletteTitle', 'Reload File from Disk'),
    description: translate(
      'editor.reloadFromDisk.paletteDescription',
      'Read the active file from disk and reload it if it changed.'
    ),
    icon: RefreshCw,
    verbKeywords: [
      translate('editor.reloadFromDisk.verbs.reloadFile', 'reload file'),
      translate('editor.reloadFromDisk.verbs.reloadFromDisk', 'reload from disk'),
      translate('editor.reloadFromDisk.verbs.refreshFile', 'refresh file'),
      translate('editor.reloadFromDisk.verbs.revertFile', 'revert file')
    ],
    isAvailable: availability,
    run: async (ctx) => {
      const fileId = ctx.activeEditorReloadFileId
      if (!fileId) {
        return { status: 'unavailable', reason: 'no-active-group' }
      }
      requestEditorReloadFromDisk(fileId)
      return { status: 'ok' }
    }
  }
}
