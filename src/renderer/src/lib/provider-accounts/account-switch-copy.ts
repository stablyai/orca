// What the running-session switch dialog, its toasts and its setting say for each agent whose
// terminals restart onto a newly selected account.

import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'

export type AccountSwitchAgent = 'claude' | 'antigravity'

export type AccountSwitchCopy = {
  agent: AccountSwitchAgent
  /** The dialog's description. `fresh`: listed sessions whose conversation Orca doesn't know. */
  body: (args: { count: number; fresh: number; previous: string; next: string }) => string
  reviewBody: (count: number, next: string) => string
  listLabel: string
  session: string
  /** Why a listed session can't move, or what its restart does differently. */
  reasonLabel: (reason: string) => string | undefined
  restarting: (count: number, account: string) => string
  /** For agents that restart without a known conversation, by starting a new one. */
  freshRestarts?: (count: number) => string
  hostAsk: (count: number, previous: string) => string
  stranded: (count: number, previous: string) => string
  settingTitle: string
  settingDescription: string
  updateFailed: string
}

export function claudeAccountSwitchCopy(t: Translate = translate): AccountSwitchCopy {
  return {
    agent: 'claude',
    body: ({ count, previous, next }) =>
      t(
        'accounts.claude.switchSessions.body',
        '{{count}} Claude sessions are still running on {{previous}}. Restarting continues each conversation on {{next}}. Busy sessions stop their current work and restart now.',
        {
          count,
          previous,
          next,
          defaultValue_one:
            '{{count}} Claude session is still running on {{previous}}. Restarting continues the conversation on {{next}}. Busy sessions stop their current work and restart now.'
        }
      ),
    reviewBody: (count, next) =>
      t(
        'accounts.claude.switchSessions.reviewBody',
        "{{count}} Claude sessions weren't moved to {{next}}.",
        { count, next, defaultValue_one: "{{count}} Claude session wasn't moved to {{next}}." }
      ),
    listLabel: t('accounts.claude.switchSessions.listLabel', 'Claude sessions to restart'),
    session: t('accounts.claude.switchSessions.session', 'Claude session'),
    reasonLabel: (reason) => {
      switch (reason) {
        case 'wsl-terminal':
          return t('accounts.claude.switchSessions.reasonWsl', 'WSL terminal')
        case 'own-folder':
          return t('accounts.claude.switchSessions.reasonOwnFolder', 'Uses your own Claude folder')
        case 'unknown-account':
          return t('accounts.claude.switchSessions.reasonUnknownAccount', 'Account unknown')
        case 'no-session':
          return t('accounts.claude.switchSessions.reasonNoSession', "Can't resume")
        case 'shared-session':
          return t(
            'accounts.claude.switchSessions.reasonSharedSession',
            'Also open in another pane'
          )
        default:
          return undefined
      }
    },
    restarting: (count, account) =>
      count === 1
        ? t(
            'accounts.claude.switchSessions.restartingOne',
            'Restarting 1 Claude session on {{account}}',
            { account }
          )
        : t(
            'accounts.claude.switchSessions.restartingOther',
            'Restarting {{count}} Claude sessions on {{account}}',
            { count, account }
          ),
    hostAsk: (count, previous) =>
      count === 1
        ? t(
            'accounts.claude.switchSessions.hostAskOne',
            '1 Claude session is still on {{previous}}.',
            { previous }
          )
        : t(
            'accounts.claude.switchSessions.hostAskOther',
            '{{count}} Claude sessions are still on {{previous}}.',
            { count, previous }
          ),
    stranded: (count, previous) =>
      count === 1
        ? t(
            'accounts.claude.switchSessions.strandedOne',
            '1 Claude session may still be on {{previous}}. Restart it manually to switch.',
            { previous }
          )
        : t(
            'accounts.claude.switchSessions.strandedOther',
            '{{count}} Claude sessions may still be on {{previous}}. Restart them manually to switch.',
            { count, previous }
          ),
    settingTitle: t(
      'accounts.claude.switchSessions.settingTitle',
      'When you switch accounts while Claude is running in terminals'
    ),
    settingDescription: t(
      'accounts.claude.switchSessions.settingDescription',
      'Restarting continues each terminal conversation on the new account. Busy sessions stop their current work.'
    ),
    updateFailed: t(
      'auto.components.settings.AccountsPane.2743cdc0af',
      'Claude account update failed.'
    )
  }
}

export function antigravityAccountSwitchCopy(t: Translate = translate): AccountSwitchCopy {
  return {
    agent: 'antigravity',
    body: ({ count, fresh, previous, next }) => {
      if (count === 1 && fresh === 1) {
        return t(
          'accounts.antigravity.switchSessions.bodyFresh',
          "1 Antigravity session is still running on {{previous}}. Orca doesn't know its conversation, so restarting starts a new one on {{next}}. A busy session stops its current work and restarts now.",
          { previous, next }
        )
      }
      const running = t(
        'accounts.antigravity.switchSessions.body',
        '{{count}} Antigravity sessions are still running on {{previous}}. Restarting continues each conversation on {{next}}. Busy sessions stop their current work and restart now.',
        {
          count,
          previous,
          next,
          defaultValue_one:
            '{{count}} Antigravity session is still running on {{previous}}. Restarting continues the conversation on {{next}}. Busy sessions stop their current work and restart now.'
        }
      )
      if (fresh === 0) {
        return running
      }
      const freshNote = t(
        'accounts.antigravity.switchSessions.bodyFreshCount',
        "{{count}} of them start new conversations, because Orca doesn't know which ones they were in.",
        {
          count: fresh,
          defaultValue_one:
            "{{count}} of them starts a new conversation, because Orca doesn't know which one it was in."
        }
      )
      return `${running} ${freshNote}`
    },
    reviewBody: (count, next) =>
      t(
        'accounts.antigravity.switchSessions.reviewBody',
        "{{count}} Antigravity sessions weren't moved to {{next}}.",
        {
          count,
          next,
          defaultValue_one: "{{count}} Antigravity session wasn't moved to {{next}}."
        }
      ),
    listLabel: t(
      'accounts.antigravity.switchSessions.listLabel',
      'Antigravity sessions to restart'
    ),
    session: t('accounts.antigravity.switchSessions.session', 'Antigravity session'),
    reasonLabel: (reason) =>
      reason === 'new-conversation'
        ? t(
            'accounts.antigravity.switchSessions.reasonNewConversation',
            'Starts a new conversation'
          )
        : undefined,
    restarting: (count, account) =>
      count === 1
        ? t(
            'accounts.antigravity.switchSessions.restartingOne',
            'Restarting 1 Antigravity session on {{account}}',
            { account }
          )
        : t(
            'accounts.antigravity.switchSessions.restartingOther',
            'Restarting {{count}} Antigravity sessions on {{account}}',
            { count, account }
          ),
    freshRestarts: (count) =>
      t(
        'accounts.antigravity.switchSessions.freshRestarts',
        "{{count}} start new conversations, because Orca doesn't know which ones they were in.",
        {
          count,
          defaultValue_one:
            "{{count}} starts a new conversation, because Orca doesn't know which one it was in."
        }
      ),
    hostAsk: (count, previous) =>
      count === 1
        ? t(
            'accounts.antigravity.switchSessions.hostAskOne',
            '1 Antigravity session is still on {{previous}}.',
            { previous }
          )
        : t(
            'accounts.antigravity.switchSessions.hostAskOther',
            '{{count}} Antigravity sessions are still on {{previous}}.',
            { count, previous }
          ),
    stranded: (count, previous) =>
      count === 1
        ? t(
            'accounts.antigravity.switchSessions.strandedOne',
            '1 Antigravity session may still be on {{previous}}. Restart it manually to switch.',
            { previous }
          )
        : t(
            'accounts.antigravity.switchSessions.strandedOther',
            '{{count}} Antigravity sessions may still be on {{previous}}. Restart them manually to switch.',
            { count, previous }
          ),
    settingTitle: t(
      'accounts.antigravity.switchSessions.settingTitle',
      'When you switch accounts while agy is running in terminals'
    ),
    settingDescription: t(
      'accounts.antigravity.switchSessions.settingDescription',
      "Restarting continues each terminal conversation on the new account, or starts a new one when Orca doesn't know it. Busy sessions stop their current work."
    ),
    updateFailed: t('accounts.antigravity.switchFailedToast', 'Antigravity account update failed.')
  }
}
