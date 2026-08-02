export function formatTerminalSessionCount(count: number): string {
  return `${count} terminal session${count === 1 ? '' : 's'}`
}

export function getResourceManagerTooltipLines(args: {
  memoryLabel: string
  sessionCount: number
  spaceScanReady: boolean
}): string[] {
  const rawMemoryLabel = args.memoryLabel.trim()
  const memoryLabel =
    rawMemoryLabel === '' || rawMemoryLabel === '-' || rawMemoryLabel === '—'
      ? 'memory unavailable'
      : rawMemoryLabel
  const lines = [
    `Resource Manager - ${memoryLabel} - ${formatTerminalSessionCount(args.sessionCount)}`
  ]

  if (args.spaceScanReady) {
    lines.push('Space scan ready')
  }

  if (args.sessionCount > 0) {
    lines.push('Terminal sessions are grouped by workspace.')
  } else {
    lines.push('No terminal sessions yet.')
  }

  return lines
}

export function getResourceManagerAriaLabel(args: {
  sessionCount: number
  spaceScanReady: boolean
}): string {
  const parts = ['Resource Manager', formatTerminalSessionCount(args.sessionCount)]

  if (args.spaceScanReady) {
    parts.push('Space scan ready')
  }

  return parts.join(', ')
}
