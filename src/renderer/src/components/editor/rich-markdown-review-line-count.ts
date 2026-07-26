export function countRichMarkdownReviewMarkdownLines(value: string): number {
  if (value.length === 0) {
    return 1
  }
  let lineCount = 1
  for (let index = 0; index < value.length; index += 1) {
    const charCode = value.charCodeAt(index)
    if (charCode === 13) {
      lineCount += 1
      if (value.charCodeAt(index + 1) === 10) {
        index += 1
      }
    } else if (charCode === 10) {
      lineCount += 1
    }
  }
  return lineCount
}
