// @protected-copy scope=file
import type { AgentChatPermissionChoice } from '../../../agent-launch/permissions/agent-chat-permission-mode'
import { tuiAgentDisplayName } from '../../../agent-launch/catalog/tui-agent-display-names'
import type { CopyTranslate } from '../../../i18n/english-translate'
import type { BotAgentSwitchPreviewResult } from '../../../rpc-contract/bot-agent-switch-params'

function permissionLabel(agent: string, mode: AgentChatPermissionChoice, t: CopyTranslate): string {
  switch (mode) {
    case 'ask':
      return t('components.native-chat.composer.permissionAsk', 'Ask for approval')
    case 'accept-edits':
      return t('components.native-chat.composer.permissionAcceptEdits', 'Accept edits')
    case 'auto':
      return t('components.native-chat.composer.permissionAuto', 'Approve for me')
    case 'full-access':
      return t('components.native-chat.composer.permissionFullAccess', 'Full access')
    case 'own':
      return t('components.native-chat.composer.permissionAgentSettings', '{{agent}} settings', {
        agent: tuiAgentDisplayName(agent) ?? agent
      })
  }
}

function effectivePermissionLabel(
  agent: string,
  mode: AgentChatPermissionChoice,
  t: CopyTranslate
): string {
  return permissionLabel(agent, agent === 'aug' ? 'own' : agent === 'pi' ? 'full-access' : mode, t)
}

function targetPermissionCopy(agent: string, t: CopyTranslate): string[] {
  const mode = permissionLabel(agent, agent === 'aug' ? 'own' : 'full-access', t)
  return [
    t('chat.providerSwitch.closestPermission', 'Closest available on {{agent}}: {{mode}}.', {
      agent: tuiAgentDisplayName(agent) ?? agent,
      mode
    }),
    agent === 'aug'
      ? t(
          'chat.providerSwitch.auggieAccess',
          'Auggie uses its own tool permissions. Orca can’t require it to ask before running tools.'
        )
      : t(
          'chat.providerSwitch.toolsRunUnprompted',
          '{{agent}}’s usual tools can run without asking for Orca approval.',
          { agent: tuiAgentDisplayName(agent) ?? agent }
        )
  ]
}

export function chatSwitchPermissionCopy(
  from: string,
  current: AgentChatPermissionChoice,
  agent: string,
  t: CopyTranslate
): string {
  return [
    t('chat.providerSwitch.currentPermission', 'Current permission: {{mode}}.', {
      mode: effectivePermissionLabel(from, current, t)
    }),
    ...targetPermissionCopy(agent, t),
    t(
      'chat.providerSwitch.existingTurnPermissions',
      'The current reply and messages already queued keep their permissions.'
    )
  ].join(' ')
}

export function botSwitchPermissionCopy(
  { from, agent, defaultPermission, home }: NonNullable<BotAgentSwitchPreviewResult['consent']>,
  t: CopyTranslate
): string[] {
  return [
    ...(home
      ? [
          t('bots.agentSwitch.currentHomePermission', 'Home Chat currently uses {{mode}}.', {
            mode: effectivePermissionLabel(home.from, home.permission, t)
          })
        ]
      : []),
    t('bots.agentSwitch.currentDefaultPermission', 'New chats currently use {{mode}}.', {
      mode: effectivePermissionLabel(from, defaultPermission, t)
    }),
    ...targetPermissionCopy(agent, t)
  ]
}

export function botSwitchExplicitAskCopy(t: CopyTranslate): string {
  return t(
    'bots.agentSwitch.saveExplicitAsk',
    'This bot will use Ask for approval instead of Same as chats. Giving chats more or less access later won’t change this bot’s setting. Switching back won’t restore Same as chats. You can turn it back on in Bot Settings.'
  )
}
