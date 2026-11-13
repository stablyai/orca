import '../../components/terminal-pane/layout/terminal-layout-leaf-traversal'
import { collectLayoutLeafIdsInOrder } from '../../../../shared/workspace-layout/terminal-topology/terminal-pane-tree'
import type { AppState } from '@/store/types'
import { isTerminalLeafId } from '../../../../shared/workspace-layout/stable-pane-id'
import { isWebTerminalSurfaceTabId } from '../../../../shared/workspace-layout/terminal-surface-id'
import type { Tab } from '../../../../shared/tab-types'
import { isRemoteRuntimePtyId } from '../../../../shared/remote-runtime/remote-runtime-pty-id'
import {
  isNativeChatTabWideFallbackSafe,
  resolveNativeChatActiveLayoutLeafId
} from '../../components/native-chat/pane/routing/native-chat-leaf-routing'
import type { MobileSessionWorktreeInputs, MountedTerminalSurfaceCapture } from './types'

export function mobileTerminalSurfaceId(parentTabId: string, leafId: string): string {
  return `${parentTabId}::${leafId}`
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
  const persistedLeafIds = collectLayoutLeafIdsInOrder(savedLayout?.root).filter(isTerminalLeafId)
  if (persistedLeafIds.length > 0) {
    return persistedLeafIds
  }
  // Only a tab with no saved layout, or an older rootless one, gets here; do not fabricate pane:1.
  return []
}

export function rendererTerminalBinding(
  numericPaneId: number | null,
  livePtyId: string | null | undefined,
  savedPtyId: string | null | undefined,
  leafCount: number | (() => number),
  tabPtyId: string | null | undefined
): string | null {
  if (numericPaneId !== null) {
    return livePtyId ?? savedPtyId ?? null
  }
  if (savedPtyId != null) {
    return savedPtyId
  }
  if (tabPtyId == null) {
    return null
  }
  return (typeof leafCount === 'function' ? leafCount() : leafCount) === 1 ? tabPtyId : null
}

/** Saved terminal leaves counted up to 2: the binding only asks "exactly one?". */
export function countSavedTerminalLeavesUpToTwo(
  savedLayout: AppState['terminalLayoutsByTabId'][string] | undefined
): number {
  let count = 0
  const stack = savedLayout?.root ? [savedLayout.root] : []
  while (stack.length > 0 && count < 2) {
    const node = stack.pop()!
    if (node.type === 'leaf') {
      count += isTerminalLeafId(node.leafId) ? 1 : 0
    } else {
      stack.push(node.second, node.first)
    }
  }
  return count
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

export function getMobileMarkdownSourceFile(
  file: AppState['openFiles'][number],
  openFilesById: ReadonlyMap<string, AppState['openFiles'][number]> | undefined
): AppState['openFiles'][number] | null {
  if (file.mode !== 'edit' && file.mode !== 'markdown-preview') {
    return null
  }
  if (file.language !== 'markdown' && file.mode !== 'markdown-preview') {
    return null
  }
  return file.mode === 'markdown-preview' && file.markdownPreviewSourceFileId
    ? (openFilesById?.get(file.markdownPreviewSourceFileId) ?? file)
    : file
}

export function isMobilePublishableOpenFile(file: AppState['openFiles'][number]): boolean {
  // A tab mirrored from a paired host is that host's; republishing it echoes it back to the host.
  if (file.mirroredFromRuntimeSession === true) {
    return false
  }
  // Virtual review/check views use display labels as paths, not readable files.
  if (file.mode !== 'edit' && file.mode !== 'diff' && file.mode !== 'markdown-preview') {
    return false
  }
  // Combined diff tabs use display labels as paths and need the desktop renderer.
  return !(
    file.diffSource === 'combined-all' ||
    file.diffSource === 'combined-uncommitted' ||
    file.diffSource === 'combined-branch' ||
    file.diffSource === 'combined-commit'
  )
}

// Hold workspace docs back: only desktop guest has their grant, and old wire clients misread unsupported tab kind as navigable browser URL.
// Negotiate capability before adding host/phone parity.
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
