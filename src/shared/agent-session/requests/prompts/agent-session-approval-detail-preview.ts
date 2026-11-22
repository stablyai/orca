/** A literal operation preview; the complete detail remains available in its disclosure. */
export function approvalDetailPreview(detail: string): string {
  const prefix = detail.slice(0, 512).split('\n', 4).join('\n')
  if (prefix.length === detail.length || prefix.trimEnd() === detail.trimEnd()) {
    return detail
  }
  const completePrefix = prefix.replace(/[\uD800-\uDBFF]$/, '').trimEnd()
  return `${completePrefix}…`
}
