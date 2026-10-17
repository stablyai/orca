/**
 * Claude's part of the shared account switch. Why resume suffices: each launch reads the selected
 * account's folder, so `claude --resume <id>` lands there intact.
 */
import {
  isAgentForegroundWrapperProcess,
  recognizeAgentProcess
} from '../../../shared/agent-process-recognition'
import type { ClaudeManagedAccount } from '../../../shared/managed-account-types'
import { translate } from '@/i18n/i18n'
import { findAccountByHomeFolder, transcriptHomeFolder } from './agent-account-switch-discovery'
import type { AccountSwitchAgent, AgentAccountSnapshot } from './agent-account-switch-agent'
import { getClaudeAccountLabel } from './claude-account-label'

function isClaudeProcess(processName: string | null): boolean {
  return (
    processName !== null &&
    (recognizeAgentProcess(processName)?.agent === 'claude' ||
      isAgentForegroundWrapperProcess(processName))
  )
}

/**
 * The Claude account a session runs on, read from where Claude writes its transcript
 * (`<CLAUDE_CONFIG_DIR>/projects/...`): a managed account's folder, else System default
 * (null). Undefined when the hook reported no transcript, so the caller cannot know.
 */
export function resolveClaudeSessionAccountId(
  transcriptPath: string | undefined,
  accounts: readonly ClaudeManagedAccount[]
): string | null | undefined {
  const configDir = transcriptHomeFolder(transcriptPath, 'projects')
  if (configDir === undefined) {
    return undefined
  }
  return (
    findAccountByHomeFolder(configDir, accounts, (account) => [
      account.managedAuthPath,
      account.wslLinuxAuthPath
    ])?.id ?? null
  )
}

/**
 * The account a launch under `accountId` runs on, as a session's transcript reports it: System
 * default (null) for an account with no login of its own that System default covers.
 */
export function claudeLaunchAccountId(
  state: AgentAccountSnapshot['state'],
  accountId: string | null
): string | null {
  const account = state.accounts.find((candidate) => candidate.id === accountId)
  return account?.runsOnSystemDefault ? null : accountId
}

export const CLAUDE_ACCOUNT_SWITCH_AGENT: AccountSwitchAgent = {
  agent: 'claude',
  settingKey: 'claudeAccountSwitchRunningSessions',
  // Why local only: a server's roster carries no account folders, so its transcripts cannot be read.
  transcriptAccountId: (transcriptPath, { state, owner }) =>
    owner.kind === 'local'
      ? resolveClaudeSessionAccountId(transcriptPath, state.settings?.claudeManagedAccounts ?? [])
      : undefined,
  launchAccountId: (snapshot) => claudeLaunchAccountId(snapshot.state, snapshot.accountId ?? null),
  accountLabel: (snapshot) => getClaudeAccountLabel(snapshot.state, snapshot.accountId),
  // Why no launch fallback: the native macOS install reads as its version folder, which the
  // fresh confirmation resolves.
  isAgentForeground: (reading) => isClaudeProcess(reading.foregroundProcess),
  copy: {
    body: (values) =>
      values.count === 1
        ? translate(
            'accounts.switchSessions.claude.bodyOne',
            '1 Claude session is still running on {{previous}}. Restarting continues the conversation on {{next}}. Busy sessions wait for idle before restarting.',
            values
          )
        : translate(
            'accounts.switchSessions.claude.bodyOther',
            '{{count}} Claude sessions are still running on {{previous}}. Restarting continues each conversation on {{next}}. Busy sessions wait for idle before restarting.',
            values
          ),
    settingTitle: () =>
      translate(
        'accounts.switchSessions.claude.settingTitle',
        'When you switch accounts while Claude is running'
      ),
    settingDescription: () =>
      translate(
        'accounts.switchSessions.claude.settingDescription',
        'Restarting continues each running conversation on the new account.'
      )
  }
}
