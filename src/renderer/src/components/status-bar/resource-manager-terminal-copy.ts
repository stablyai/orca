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

/**
 * `emphasized` marks the space-scan row the tooltip tints. The segment used to
 * recognize that row by comparing it against the English text, which stops
 * matching the moment the copy comes from the catalog.
 *
 * `id` names the row's role. Each role appears at most once per tooltip, so it is
 * a unique React key that survives locale switches and memory/count updates —
 * unlike the translated text, which locales are free to duplicate across rows.
 */
export type ResourceManagerTooltipLine = {
  id: 'summary' | 'space-scan' | 'sessions-hint'
  text: string
  emphasized: boolean
}

export function getResourceManagerTooltipLines(args: {
  memoryLabel: string
  sessionCount: number
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
  // Why: whole lines are single keys — locales reorder the summary and repunctuate
  // its separators, so it can't be concatenated from translated fragments here.
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
      args.sessionCount > 0
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
