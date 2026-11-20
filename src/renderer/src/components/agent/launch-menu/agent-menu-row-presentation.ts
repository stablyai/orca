import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import { getAgentCatalog } from '@/lib/agent-catalog/agent-catalog'
import type {
  ChatUnavailableReason,
  NewTabAgentMenuRow
} from '../../../../../shared/agent-launch/picker/agent-launch-picker-rows'

export function chatUnavailableLabel(
  reason: ChatUnavailableReason,
  t: Translate = translate
): string {
  switch (reason) {
    case 'check-failed':
      return t(
        'auto.components.tab.bar.QuickLaunchButton.chatCheckFailed',
        'Couldn’t check chat availability'
      )
    case 'not-installed':
      return t('auto.components.tab.bar.QuickLaunchButton.chatNotInstalled', 'Not installed')
    case 'ssh':
      return t('auto.components.tab.bar.QuickLaunchButton.chatNotOverSsh', 'No chat over SSH')
    case 'wsl':
      return t('auto.components.tab.bar.QuickLaunchButton.chatNotInWsl', 'No chat in WSL')
    case 'subfolder':
      return t(
        'auto.components.tab.bar.QuickLaunchButton.chatNotInSubfolder',
        'No chat in a subfolder'
      )
    case 'not-on-host':
      return t('auto.components.tab.bar.QuickLaunchButton.chatNotOnHost', 'No chat on this host')
    case 'windows':
      return t(
        'auto.components.tab.bar.QuickLaunchButton.chatNotOnWindows',
        'No chat on Windows yet'
      )
  }
}

/** What a row says beside its name: why its chat can't start, or that the chat asks to install the agent. */
export function rowStatusLabel(
  row: NewTabAgentMenuRow,
  t: Translate = translate
): string | undefined {
  return row.kind === 'chat-unavailable'
    ? chatUnavailableLabel(row.reason, t)
    : row.kind === 'chat' && row.setup
      ? t('auto.components.tab.bar.QuickLaunchButton.chatInstallRequired', 'Install required')
      : undefined
}

/** An agent's chat that offers to install the agent, for surfaces that list whole agents. */
export function entrySetupLabel(
  entry: { rows: readonly NewTabAgentMenuRow[] },
  t: Translate = translate
): string | undefined {
  const row = entry.rows.find((candidate) => candidate.kind === 'chat' && candidate.setup)
  return row ? rowStatusLabel(row, t) : undefined
}

export function rowTitle(row: NewTabAgentMenuRow, label: string, t: Translate = translate): string {
  return row.kind === 'chat'
    ? t('auto.components.tab.bar.QuickLaunchButton.startChat', 'Start a chat with {{value0}}', {
        value0: label
      })
    : t(
        'auto.components.tab.bar.QuickLaunchButton.ec2adf093e',
        'Launch {{value0}} in a new terminal',
        { value0: label }
      )
}

export function rowLabel(row: NewTabAgentMenuRow, t: Translate = translate): string {
  const label =
    row.copy?.name ?? getAgentCatalog().find((entry) => entry.id === row.agent)?.label ?? row.agent
  return row.kind === 'cli'
    ? `${label} ${t('auto.components.tab.bar.QuickLaunchButton.cliTag', '(CLI)')}`
    : label
}

export function rowId(row: NewTabAgentMenuRow): string {
  const id = row.copy?.id ?? row.agent
  return `${row.kind === 'chat-unavailable' ? 'chat' : row.kind}:${id}`
}
