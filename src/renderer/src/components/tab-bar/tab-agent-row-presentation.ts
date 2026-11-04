import { translate } from '@/i18n/i18n'
import { getAgentCatalog } from '@/lib/agent-catalog'
import type {
  ChatUnavailableReason,
  NewTabAgentMenuRow
} from '../../../../shared/agent-launch/picker/agent-launch-picker-rows'

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

/** Menu label for a row: the agent name, a CLI tag for terminal rows, or "Claude · <profile>". */
export function rowLabel(row: NewTabAgentMenuRow): string {
  const label = getAgentCatalog().find((entry) => entry.id === row.agent)?.label ?? row.agent
  if (row.claudeConfigProfile) {
    return translate('accounts.claude.configProfiles.menuLabel', '{{agent}} · {{profile}}', {
      agent: label,
      profile: row.claudeConfigProfile.label
    })
  }
  return row.kind === 'cli'
    ? `${label} ${translate('auto.components.tab.bar.QuickLaunchButton.cliTag', '(CLI)')}`
    : label
}

/** Stable row key; profile rows add their profile id so two profiles never share one. */
export function rowId(row: NewTabAgentMenuRow): string {
  const id = `${row.kind === 'chat-unavailable' ? 'chat' : row.kind}:${row.agent}`
  return row.claudeConfigProfile ? `${id}:profile:${row.claudeConfigProfile.id}` : id
}
