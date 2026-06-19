export function formatTerminalSessionCount(count: number): string {
  return `${count} terminal session${count === 1 ? '' : 's'}`
}

export function getResourceManagerTooltipLines(args: {
  memoryLabel: string
  sessionCount: number
  runtimeEnvironmentActive: boolean
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

  if (args.spaceScanReady && !args.runtimeEnvironmentActive) {
    lines.push('Space scan ready')
  }

  if (args.runtimeEnvironmentActive) {
    lines.push('Local terminal sessions are hidden for runtime servers.')
  } else if (args.sessionCount > 0) {
    lines.push('Terminal sessions are grouped by workspace.')
  } else {
    lines.push('No terminal sessions yet.')
  }

  return lines
}

export function getResourceManagerAriaLabel(args: {
  sessionCount: number
  runtimeEnvironmentActive: boolean
  spaceScanReady: boolean
}): string {
  const parts = ['Resource Manager', formatTerminalSessionCount(args.sessionCount)]

  if (args.spaceScanReady && !args.runtimeEnvironmentActive) {
    parts.push('Space scan ready')
  }

  if (args.runtimeEnvironmentActive) {
    parts.push('local sessions hidden for runtime server')
  }

  return parts.join(', ')
}
