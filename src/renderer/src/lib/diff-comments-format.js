// Why: the pasted format is the contract between this feature and whatever
// agent consumes it. Keep it stable and deterministic — quote escaping matters
// because the body is surfaced inside literal quotes. Escape backslashes
// first so that `\"` in user input does not decay into an unescaped quote.
export function formatDiffComment(c) {
  const escaped = c.body
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
  return [
    `File: ${c.filePath}`,
    `Line: ${c.lineNumber}`,
    `User comment: "${escaped}"`,
    `Comment metadata: This comment was left on the modified branch.`
  ].join('\n')
}
export function formatDiffComments(comments) {
  return comments.map(formatDiffComment).join('\n\n')
}
