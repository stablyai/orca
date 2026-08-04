import { translate } from '@/i18n/i18n'

export function formatTerminalSessionCount(count: number): string {
  return count === 1
    ? translate(
        'auto.components.status.bar.resource.manager.terminal.copy.terminalSessionCount_one',
        '{{count}} terminal session',
        { count }
      )
    : translate(
        'auto.components.status.bar.resource.manager.terminal.copy.terminalSessionCount_other',
        '{{count}} terminal sessions',
        { count }
      )
}

function spaceScanReadyLabel(): string {
  return translate(
    'auto.components.status.bar.resource.manager.terminal.copy.spaceScanReady',
    'Space scan ready'
  )
}

export function getResourceManagerTooltipLines(args: {
  memoryLabel: string
  sessionCount: number
  spaceScanReady: boolean
}): string[] {
  const rawMemoryLabel = args.memoryLabel.trim()
  const memoryLabel =
    rawMemoryLabel === '' || rawMemoryLabel === '-' || rawMemoryLabel === '—'
      ? translate(
          'auto.components.status.bar.resource.manager.terminal.copy.memoryUnavailable',
          'memory unavailable'
        )
      : rawMemoryLabel
  // Why: whole lines are single keys — locales reorder the summary and repunctuate
  // its separators, so it can't be concatenated from translated fragments here.
  const lines = [
    translate(
      'auto.components.status.bar.resource.manager.terminal.copy.tooltipSummary',
      'Resource Manager - {{memory}} - {{sessions}}',
      { memory: memoryLabel, sessions: formatTerminalSessionCount(args.sessionCount) }
    )
  ]

  if (args.spaceScanReady) {
    lines.push(spaceScanReadyLabel())
  }

  if (args.sessionCount > 0) {
    lines.push(
      translate(
        'auto.components.status.bar.resource.manager.terminal.copy.sessionsGroupedByWorkspace',
        'Terminal sessions are grouped by workspace.'
      )
    )
  } else {
    lines.push(
      translate(
        'auto.components.status.bar.resource.manager.terminal.copy.noTerminalSessions',
        'No terminal sessions yet.'
      )
    )
  }

  return lines
}

export function getResourceManagerAriaLabel(args: {
  sessionCount: number
  spaceScanReady: boolean
}): string {
  const sessions = formatTerminalSessionCount(args.sessionCount)

  if (args.spaceScanReady) {
    return translate(
      'auto.components.status.bar.resource.manager.terminal.copy.ariaLabelWithSpaceScan',
      'Resource Manager, {{sessions}}, {{spaceScan}}',
      { sessions, spaceScan: spaceScanReadyLabel() }
    )
  }

  return translate(
    'auto.components.status.bar.resource.manager.terminal.copy.ariaLabel',
    'Resource Manager, {{sessions}}',
    { sessions }
  )
}
