import { measureClipboardTextByteLength } from '../../../shared/clipboard-text'

export const JIRA_BOARD_DRAG_ISSUE_MIME = 'application/x-orca-jira-issue-ref'
export const JIRA_BOARD_DRAG_ISSUE_REF_MAX_BYTES = 1024

// Why: Jira issue keys are only unique per site, so the payload carries both.
export type JiraBoardIssueDragRef = { key: string; siteId?: string }

export type JiraBoardIssueDragReadResult =
  | { status: 'issue'; ref: JiraBoardIssueDragRef }
  | { status: 'hidden' }
  | { status: 'missing' }
  | { status: 'rejected'; reason: 'too-large' | 'malformed' }

export function writeJiraBoardIssueDragData(
  dataTransfer: Pick<DataTransfer, 'setData'> & { effectAllowed: string },
  ref: JiraBoardIssueDragRef
): boolean {
  if (!ref.key) {
    return false
  }
  const payload = JSON.stringify(
    ref.siteId ? { key: ref.key, siteId: ref.siteId } : { key: ref.key }
  )
  if (isJiraBoardIssueRefTooLarge(payload)) {
    return false
  }
  dataTransfer.effectAllowed = 'move'
  dataTransfer.setData(JIRA_BOARD_DRAG_ISSUE_MIME, payload)
  dataTransfer.setData('text/plain', ref.key)
  return true
}

export function readJiraBoardIssueDragData(
  dataTransfer: Pick<DataTransfer, 'getData' | 'types'>
): JiraBoardIssueDragReadResult {
  const hasTypedPayload = Array.from(dataTransfer.types).includes(JIRA_BOARD_DRAG_ISSUE_MIME)
  const payload = dataTransfer.getData(JIRA_BOARD_DRAG_ISSUE_MIME)
  if (!payload) {
    // Electron hides getData during dragover; a present MIME with empty data is pending readability, not absent payload.
    return hasTypedPayload ? { status: 'hidden' } : { status: 'missing' }
  }
  if (isJiraBoardIssueRefTooLarge(payload)) {
    return { status: 'rejected', reason: 'too-large' }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(payload)
  } catch {
    return { status: 'rejected', reason: 'malformed' }
  }
  if (!parsed || typeof parsed !== 'object') {
    return { status: 'rejected', reason: 'malformed' }
  }
  if (!('key' in parsed) || typeof parsed.key !== 'string' || parsed.key.length === 0) {
    return { status: 'rejected', reason: 'malformed' }
  }
  const siteId = 'siteId' in parsed ? parsed.siteId : undefined
  if (siteId !== undefined && typeof siteId !== 'string') {
    return { status: 'rejected', reason: 'malformed' }
  }
  return {
    status: 'issue',
    ref: siteId ? { key: parsed.key, siteId } : { key: parsed.key }
  }
}

function isJiraBoardIssueRefTooLarge(payload: string): boolean {
  return (
    payload.length > JIRA_BOARD_DRAG_ISSUE_REF_MAX_BYTES ||
    measureClipboardTextByteLength(payload, {
      stopAfterBytes: JIRA_BOARD_DRAG_ISSUE_REF_MAX_BYTES
    }).exceededLimit
  )
}
