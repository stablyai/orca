import type { Tab } from '../../../../../../shared/tab-types'
import { isEditorTabContentType } from '@/store/slices/editor/tabs/editor-tab-content-type'

export type SourceControlRowOpenEvent = {
  altKey: boolean
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
  openAsPermanent?: boolean
}

type SourceControlOpenModifierKeys = Pick<
  SourceControlRowOpenEvent,
  'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey'
>

export function isSourceControlSplitOpenModifier(
  event: SourceControlRowOpenEvent,
  isMac: boolean
): boolean {
  const platformPrimary = isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey
  return platformPrimary || event.shiftKey || event.altKey
}

export function shouldOpenSourceControlRowAsPreview(
  event: SourceControlRowOpenEvent | undefined,
  targetGroupId: string | undefined
): boolean {
  return !targetGroupId && event?.openAsPermanent !== true
}

export function toSourceControlRowOpenEvent(
  event: SourceControlOpenModifierKeys
): SourceControlRowOpenEvent {
  return {
    altKey: event.altKey,
    ctrlKey: event.ctrlKey,
    metaKey: event.metaKey,
    shiftKey: event.shiftKey
  }
}

export function toPermanentSourceControlRowOpenEvent(
  event: SourceControlOpenModifierKeys
): SourceControlRowOpenEvent {
  return { ...toSourceControlRowOpenEvent(event), openAsPermanent: true }
}

type SideSplitCandidateTab = Pick<Tab, 'groupId' | 'contentType' | 'isPreview'>

function isEditorContentTab(tab: SideSplitCandidateTab): boolean {
  return isEditorTabContentType(tab.contentType)
}

export type SideSplitDiffColumn = {
  /** Group to open the diff in; undefined tells the caller to create a fresh right split. */
  groupId: string | undefined
  /** Whether the caller must record the resulting group as this worktree's diff column. */
  shouldRecord: boolean
}

export type SideSplitDiffColumnInput = {
  tabs: readonly SideSplitCandidateTab[]
  activeGroupId: string | undefined
  liveGroupIds: readonly string[]
  /** Diff column this worktree already committed to, if any. */
  recordedGroupId: string | undefined
}

/** Resolves the recorded diff column, else a one-time inference the caller records. */
export function resolveSideSplitDiffColumn({
  tabs,
  activeGroupId,
  liveGroupIds,
  recordedGroupId
}: SideSplitDiffColumnInput): SideSplitDiffColumn {
  // Why: a live recorded column outranks inference; inferring per open made the setting a no-op.
  if (recordedGroupId && liveGroupIds.includes(recordedGroupId)) {
    return { groupId: recordedGroupId, shouldRecord: false }
  }
  // Why: any editor-family preview counts; skipping a parked non-diff preview orphans it (#11839).
  const previewGroupId = tabs.find(
    (tab) => tab.isPreview && isEditorContentTab(tab) && tab.groupId !== activeGroupId
  )?.groupId
  if (previewGroupId) {
    return { groupId: previewGroupId, shouldRecord: true }
  }
  // Why: narrower than above — with no preview to recycle, only a diff tab marks the column.
  const diffGroupId = tabs.find(
    (tab) => tab.contentType === 'diff' && tab.groupId !== activeGroupId
  )?.groupId
  return { groupId: diffGroupId, shouldRecord: true }
}
