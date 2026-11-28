import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'

export function formatTerminalSessionCount(count: number | null, t: Translate = translate): string {
  if (count === null) {
    return t('resourceManager.countUnavailable', 'terminal count unavailable')
  }
  return t(
    'auto.components.status.bar.resource.manager.terminal.copy.terminalSessionCount',
    '{{count}} terminal sessions',
    { count, defaultValue_one: '{{count}} terminal session' }
  )
}

function appMemoryText(memory: string, t: Translate): string {
  return t(
    'auto.components.status.bar.resource.manager.terminal.copy.appMemory',
    'Orca app memory: {{memory}}',
    { memory }
  )
}

function spaceScanReadyLabel(t: Translate = translate): string {
  return t(
    'auto.components.status.bar.resource.manager.terminal.copy.spaceScanReady',
    'Space scan ready'
  )
}

/** Use stable role IDs for React keys and emphasis flags instead of locale-dependent text matching. */
export type ResourceManagerTooltipLine = {
  id: 'summary' | 'app-memory' | 'space-scan' | 'sessions-hint'
  text: string
  emphasized: boolean
}

export function getResourceManagerTooltipLines(
  args: {
    sessionCount: number | null
    spaceScanReady: boolean
    appMemoryLabel: string | null
  },
  t: Translate = translate
): ResourceManagerTooltipLine[] {
  // Why: only Orca's own app memory shows while closed; the full per-owner sweep runs only when open.
  const lines: ResourceManagerTooltipLine[] = [
    {
      id: 'summary',
      text: t(
        'auto.components.status.bar.resource.manager.terminal.copy.ariaLabel',
        'Resource Manager, {{sessions}}',
        { sessions: formatTerminalSessionCount(args.sessionCount, t) }
      ),
      emphasized: false
    }
  ]

  if (args.appMemoryLabel !== null) {
    lines.push({ id: 'app-memory', text: appMemoryText(args.appMemoryLabel, t), emphasized: false })
  }

  if (args.spaceScanReady) {
    lines.push({ id: 'space-scan', text: spaceScanReadyLabel(t), emphasized: true })
  }

  lines.push({
    id: 'sessions-hint',
    text:
      args.sessionCount === null
        ? t('resourceManager.openToObserve', 'Open Resources to observe terminal sessions.')
        : args.sessionCount !== null && args.sessionCount > 0
          ? t(
              'auto.components.status.bar.resource.manager.terminal.copy.sessionsGroupedByWorkspace',
              'Terminal sessions are grouped by workspace.'
            )
          : t(
              'auto.components.status.bar.resource.manager.terminal.copy.noTerminalSessions',
              'No terminal sessions yet.'
            ),
    emphasized: false
  })

  return lines
}

export function getResourceManagerAriaLabel(
  args: {
    sessionCount: number | null
    spaceScanReady: boolean
    appMemoryLabel: string | null
  },
  t: Translate = translate
): string {
  const sessions =
    args.appMemoryLabel === null
      ? formatTerminalSessionCount(args.sessionCount, t)
      : t(
          'auto.components.status.bar.resource.manager.terminal.copy.appMemoryAndSessions',
          'Orca app memory {{memory}} (Orca’s own processes, not terminals or agent CLIs), {{sessions}}',
          {
            memory: args.appMemoryLabel,
            sessions: formatTerminalSessionCount(args.sessionCount, t)
          }
        )

  if (args.spaceScanReady) {
    return t(
      'auto.components.status.bar.resource.manager.terminal.copy.ariaLabelWithSpaceScan',
      'Resource Manager, {{sessions}}, {{spaceScan}}',
      { sessions, spaceScan: spaceScanReadyLabel(t) }
    )
  }

  return t(
    'auto.components.status.bar.resource.manager.terminal.copy.ariaLabel',
    'Resource Manager, {{sessions}}',
    { sessions }
  )
}
