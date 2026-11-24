type BrowserImportSummaryLabel = {
  label: string
}

export type FormatBrowserImportSummaryArgs = {
  detectedBrowsers: readonly BrowserImportSummaryLabel[]
  detectedBrowsersLoaded: boolean
  supportedImportLabels: readonly string[]
  maxNamed?: number
}

function formatLabelList(prefix: string, labels: readonly string[], maxNamed: number): string {
  if (labels.length === 0) {
    return `${prefix} file.`
  }
  if (labels.length <= maxNamed) {
    return `${prefix}: ${labels.join(', ')}.`
  }

  const named = labels.slice(0, maxNamed)
  const remaining = labels.length - maxNamed
  return `${prefix}: ${named.join(', ')}, +${remaining} more.`
}

export function formatBrowserImportSummary({
  detectedBrowsers,
  detectedBrowsersLoaded,
  supportedImportLabels,
  maxNamed = 4
}: FormatBrowserImportSummaryArgs): string {
  if (detectedBrowsersLoaded && detectedBrowsers.length > 0) {
    return formatLabelList(
      'Detected',
      detectedBrowsers.map((browser) => browser.label),
      maxNamed
    )
  }

  return formatLabelList('Import from', supportedImportLabels, maxNamed)
}
