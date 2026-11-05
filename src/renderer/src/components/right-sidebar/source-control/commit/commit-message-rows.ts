export const COMMIT_MESSAGE_ROW_SCAN_CODE_UNITS = 64 * 1024

export function getCommitMessageTextareaRows(message: string): number {
  return Math.min(12, Math.max(2, countCommitMessageRows(message)))
}

function countCommitMessageRows(message: string): number {
  if (message.length === 0) {
    return 1
  }

  const scanLength = Math.min(message.length, COMMIT_MESSAGE_ROW_SCAN_CODE_UNITS)
  let rows = 1
  for (let index = 0; index < scanLength; index += 1) {
    if (message.charCodeAt(index) !== 10) {
      continue
    }
    rows += 1
    if (rows >= 12) {
      return rows
    }
  }
  return rows
}
