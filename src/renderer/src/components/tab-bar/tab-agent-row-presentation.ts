import { translate } from '@/i18n/i18n'
import type { TuiAgent } from '../../../../shared/tui-agent'
import { getAgentCatalog } from '@/lib/agent-catalog'
import type { ChatUnavailableReason, NewTabAgentMenuRow } from '@/lib/new-tab-agent-menu-rows'

export function chatUnavailableLabel(reason: ChatUnavailableReason): string {
  switch (reason) {
    case 'check-failed':
      return translate(
        'auto.components.tab.bar.QuickLaunchButton.chatCheckFailed',
        'Couldn’t check chat availability'
      )
    case 'not-installed':
      return translate(
        'auto.components.tab.bar.QuickLaunchButton.chatNotInstalled',
        'Not installed'
      )
    case 'ssh':
      return translate(
        'auto.components.tab.bar.QuickLaunchButton.chatNotOverSsh',
        'No chat over SSH'
      )
    case 'wsl':
      return translate('auto.components.tab.bar.QuickLaunchButton.chatNotInWsl', 'No chat in WSL')
    case 'subfolder':
      return translate(
        'auto.components.tab.bar.QuickLaunchButton.chatNotInSubfolder',
        'No chat in a subfolder'
      )
    case 'not-on-host':
      return translate(
        'auto.components.tab.bar.QuickLaunchButton.chatNotOnHost',
        'No chat on this host'
      )
  }
}

export function rowTitle(row: NewTabAgentMenuRow, label: string): string {
  return row.kind === 'chat'
    ? translate(
        'auto.components.tab.bar.QuickLaunchButton.startChat',
        'Start a chat with {{value0}}',
        {
          value0: label
        }
      )
    : translate(
        'auto.components.tab.bar.QuickLaunchButton.ec2adf093e',
        'Launch {{value0}} in a new terminal',
        { value0: label }
      )
}

export function agentLabel(agent: TuiAgent): string {
  return getAgentCatalog().find((entry) => entry.id === agent)?.label ?? agent
}

export function rowLabel(row: NewTabAgentMenuRow): string {
  const label = agentLabel(row.agent)
  return row.kind === 'cli'
    ? `${label} ${translate('auto.components.tab.bar.QuickLaunchButton.cliTag', '(CLI)')}`
    : label
}

export function rowId(row: NewTabAgentMenuRow): string {
  return `${row.kind === 'chat-unavailable' ? 'chat' : row.kind}:${row.agent}`
}

/** The same agent on the other surface: a chat's detected CLI, or a CLI-set agent's chat. */
export function otherSurfaceRow(
  row: Exclude<NewTabAgentMenuRow, { kind: 'chat-unavailable' }>,
  detectedIds: readonly TuiAgent[] | null
): NewTabAgentMenuRow | null {
  const { agent, executionHostId } = row
  if (row.kind === 'chat') {
    return detectedIds?.includes(agent) ? { kind: 'cli', agent, executionHostId } : null
  }
  return row.kind === 'cli' && row.chat ? { kind: 'chat', agent, executionHostId } : null
}
