import { translate } from '@/i18n/i18n'

export function formatTerminalSessionCount(count: number | null): string {
  if (count === null) {
    return translate('resourceManager.countUnavailable', 'terminal count unavailable')
  }
  return translate(
    'auto.components.status.bar.resource.manager.terminal.copy.terminalSessionCount',
    '{{count}} terminal sessions',
    { count, defaultValue_one: '{{count}} terminal session' }
  )
}

function spaceScanReadyLabel(): string {
  return translate(
    'auto.components.status.bar.resource.manager.terminal.copy.spaceScanReady',
    'Space scan ready'
  )
}

/** Use stable role IDs for React keys and emphasis flags instead of locale-dependent text matching. */
export type ResourceManagerTooltipLine = {
  id: 'summary' | 'space-scan' | 'sessions-hint'
  text: string
  emphasized: boolean
}

export function getResourceManagerTooltipLines(args: {
  memoryLabel: string
  sessionCount: number | null
  spaceScanReady: boolean
}): ResourceManagerTooltipLine[] {
  const rawMemoryLabel = args.memoryLabel.trim()
  const memoryLabel =
    rawMemoryLabel === '' || rawMemoryLabel === '-' || rawMemoryLabel === '—'
      ? translate(
          'auto.components.status.bar.resource.manager.terminal.copy.memoryUnavailable',
          'memory unavailable'
        )
      : rawMemoryLabel
  // Translate whole summary lines so locales can reorder fields and separators.
  const lines: ResourceManagerTooltipLine[] = [
    {
      id: 'summary',
      text: translate(
        'auto.components.status.bar.resource.manager.terminal.copy.tooltipSummary',
        'Resource Manager - {{memory}} - {{sessions}}',
        { memory: memoryLabel, sessions: formatTerminalSessionCount(args.sessionCount) }
      ),
      emphasized: false
    }
  ]

  if (args.spaceScanReady) {
    lines.push({ id: 'space-scan', text: spaceScanReadyLabel(), emphasized: true })
  }

  lines.push({
    id: 'sessions-hint',
    text:
      args.sessionCount === null
        ? translate('resourceManager.openToObserve', 'Open Resources to observe terminal sessions.')
        : args.sessionCount !== null && args.sessionCount > 0
          ? translate(
              'auto.components.status.bar.resource.manager.terminal.copy.sessionsGroupedByWorkspace',
              'Terminal sessions are grouped by workspace.'
            )
          : translate(
              'auto.components.status.bar.resource.manager.terminal.copy.noTerminalSessions',
              'No terminal sessions yet.'
            ),
    emphasized: false
  })

  return lines
}

export function getResourceManagerAriaLabel(args: {
  sessionCount: number | null
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
