import { measureClipboardTextByteLength } from '../../../shared/clipboard-text'

export const LINEAR_BOARD_DRAG_ISSUE_MIME = 'application/x-orca-linear-issue-id'
export const LINEAR_BOARD_DRAG_ISSUE_ID_MAX_BYTES = 1024

export type LinearBoardIssueDragReadResult =
  | { status: 'issue'; issueId: string }
  | { status: 'hidden' }
  | { status: 'missing' }
  | { status: 'rejected'; reason: 'too-large' }

export function writeLinearBoardIssueDragData(
  dataTransfer: Pick<DataTransfer, 'setData'> & { effectAllowed: string },
  issueId: string
): boolean {
  if (!issueId || isLinearBoardIssueIdTooLarge(issueId)) {
    return false
  }
  dataTransfer.effectAllowed = 'move'
  dataTransfer.setData(LINEAR_BOARD_DRAG_ISSUE_MIME, issueId)
  dataTransfer.setData('text/plain', issueId)
  return true
}

export function readLinearBoardIssueDragData(
  dataTransfer: Pick<DataTransfer, 'getData' | 'types'>
): LinearBoardIssueDragReadResult {
  const hasTypedPayload = Array.from(dataTransfer.types).includes(LINEAR_BOARD_DRAG_ISSUE_MIME)
  const issueId = dataTransfer.getData(LINEAR_BOARD_DRAG_ISSUE_MIME)
  if (!issueId) {
    return hasTypedPayload ? { status: 'hidden' } : { status: 'missing' }
  }
  if (isLinearBoardIssueIdTooLarge(issueId)) {
    return { status: 'rejected', reason: 'too-large' }
  }
  return { status: 'issue', issueId }
}

function isLinearBoardIssueIdTooLarge(issueId: string): boolean {
  return (
    issueId.length > LINEAR_BOARD_DRAG_ISSUE_ID_MAX_BYTES ||
    measureClipboardTextByteLength(issueId, {
      stopAfterBytes: LINEAR_BOARD_DRAG_ISSUE_ID_MAX_BYTES
    }).exceededLimit
  )
}
