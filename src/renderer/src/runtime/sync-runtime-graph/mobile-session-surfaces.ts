import { collectLeafIdsInOrder } from '@/components/terminal-pane/layout-serialization'
import type { AppState } from '@/store/types'
import { isClaudeManagementTitle } from '../../../../shared/agent-detection'
import { isTerminalLeafId, makePaneKey } from '../../../../shared/stable-pane-id'
import { isWebTerminalSurfaceTabId } from '../../../../shared/terminal-surface-id'
import type { Tab } from '../../../../shared/tab-types'
import { parseRemoteRuntimePtyId } from '../runtime-terminal-stream'
import {
  isNativeChatTabWideFallbackSafe,
  nativeChatLaunchAgentForLeaf,
  resolveNativeChatActiveLayoutLeafId
} from '../../components/native-chat/native-chat-leaf-routing'
import type { MobileSessionWorktreeInputs, MountedTerminalSurfaceCapture } from './types'

export function mobileTerminalSurfaceId(parentTabId: string, leafId: string): string {
  return `${parentTabId}::${leafId}`
}

export function isRemoteRuntimePtyId(ptyId: string | null | undefined): boolean {
  return typeof ptyId === 'string' && parseRemoteRuntimePtyId(ptyId) !== null
}

export function isWebOnlyMirroredTerminalTab(
  tab: Pick<NonNullable<AppState['tabsByWorktree'][string]>[number], 'id' | 'ptyId'>,
  layout: AppState['terminalLayoutsByTabId'][string] | undefined
): boolean {
  if (!isWebTerminalSurfaceTabId(tab.id)) {
    return false
  }
  const layoutPtyIds = Object.values(layout?.ptyIdsByLeafId ?? {})
  const ptyIds = [tab.ptyId, ...layoutPtyIds].filter(
    (ptyId): ptyId is string => typeof ptyId === 'string' && ptyId.length > 0
  )
  // Only-remote/no-PTY tabs are web mirrors; legacy local-PTY tabs still publish.
  return ptyIds.every(isRemoteRuntimePtyId)
}

export function getRuntimeLeafIdsForTerminal(
  capture: MountedTerminalSurfaceCapture | undefined,
  savedLayout: AppState['terminalLayoutsByTabId'][string] | undefined
): readonly string[] {
  const liveLeafIds = capture?.paneLeafIds ?? []
  if (liveLeafIds.length > 0) {
    return liveLeafIds
  }
  const persistedLeafIds = collectLeafIdsInOrder(savedLayout?.root).filter(isTerminalLeafId)
  if (persistedLeafIds.length > 0) {
    return persistedLeafIds
  }
  // A new tab can predate TerminalPane mount; do not fabricate a stale pane:1.
  return []
}

export function resolveMobileTabWideAgentHintLeafId(
  capture: MountedTerminalSurfaceCapture | undefined,
  savedLayout: AppState['terminalLayoutsByTabId'][string] | undefined
): string | null {
  if (capture) {
    return capture.tabWideAgentHintLeafId
  }
  return isNativeChatTabWideFallbackSafe(savedLayout)
    ? resolveNativeChatActiveLayoutLeafId(savedLayout)
    : null
}

export function isEditorSurfaceTab(tab: Pick<Tab, 'contentType'>): boolean {
  // Mobile can mirror ordinary edit/diff files; other editor tabs need extra metadata.
  return tab.contentType === 'editor' || tab.contentType === 'diff'
}

export function isFileActiveEditorSurface(
  inputs: Pick<MobileSessionWorktreeInputs, 'activeEditorFileId' | 'activeEditorTabType'>,
  file: Pick<AppState['openFiles'][number], 'id'>
): boolean {
  return inputs.activeEditorTabType === 'editor' && inputs.activeEditorFileId === file.id
}

export function isMobileFileDiffSource(
  diffSource: AppState['openFiles'][number]['diffSource']
): diffSource is 'staged' | 'unstaged' {
  return diffSource === 'staged' || diffSource === 'unstaged'
}

export function isMobilePublishableOpenFile(file: AppState['openFiles'][number]): boolean {
  // Combined diff tabs use display labels as paths and need the desktop renderer.
  return !(
    file.diffSource === 'combined-all' ||
    file.diffSource === 'combined-uncommitted' ||
    file.diffSource === 'combined-branch' ||
    file.diffSource === 'combined-commit'
  )
}

/**
 * Why a workspace document is held back: it is served to one desktop guest through a grant no
 * mobile client holds, so there is nothing on the other side that could render it — and the wire
 * has no tab kind for it, so an old client would take it for an ordinary browser tab and offer
 * navigation for a page that has no URL. Host and phone parity ships behind capability negotiation.
 */
export function isMobilePublishableBrowserWorkspace(
  workspace: NonNullable<AppState['browserTabsByWorktree'][string]>[number]
): boolean {
  return !workspace.docLocation
}

export function isUnifiedTabActiveInActiveGroup(
  inputs: Pick<MobileSessionWorktreeInputs, 'groups' | 'activeGroupId'>,
  unifiedTabId: string
): boolean {
  return inputs.groups.some(
    (group) => group.id === inputs.activeGroupId && group.activeTabId === unifiedTabId
  )
}

export { isClaudeManagementTitle, isTerminalLeafId, makePaneKey, nativeChatLaunchAgentForLeaf }
