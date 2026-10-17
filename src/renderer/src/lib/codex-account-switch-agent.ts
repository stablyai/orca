/**
 * Codex's part of the shared account switch. Codex writes each rollout under its launch
 * CODEX_HOME (`<home>/sessions/...`), and a launch reads the selected account's home, so the
 * transcript path names the account a session runs on.
 */
import { translate } from '@/i18n/i18n'
import type { AccountSwitchAgent } from './agent-account-switch-agent'
import {
  CODEX_ACCOUNT_RESTART_STARTUP,
  resolveCodexSwitchAccountLabel
} from './codex-session-restart'
import { isCodexRestartEligiblePane } from './codex-pane-restart-eligibility'

// Why the layout and not a roster: a server's roster carries no home paths, and Orca keeps every
// saved account's home, host or WSL, at `.../codex-accounts/<id>/home`.
const SAVED_ACCOUNT_SESSIONS = /\/codex-accounts\/([^/]+)\/home\/sessions\//gi
// Why the mirror counts: a System default launch runs there when the user sets their own CODEX_HOME.
const SYSTEM_DEFAULT_SESSIONS = /\/(\.codex|codex-runtime-home\/home)\/sessions\//i

/**
 * The Codex account a session runs on, from its rollout's `<CODEX_HOME>/sessions/...` path: a
 * saved account's id, null for System default, undefined when the home is neither.
 */
export function resolveCodexSessionAccountId(
  transcriptPath: string | undefined
): string | null | undefined {
  const slashed = transcriptPath?.replace(/\\/g, '/') ?? ''
  const saved = [...slashed.matchAll(SAVED_ACCOUNT_SESSIONS)].at(-1)
  if (saved) {
    return saved[1]
  }
  return SYSTEM_DEFAULT_SESSIONS.test(slashed) ? null : undefined
}

export const CODEX_ACCOUNT_SWITCH_AGENT: AccountSwitchAgent = {
  agent: 'codex',
  settingKey: 'codexAccountSwitchRunningSessions',
  // Why: Codex can start a session over without its history, so one with none to resume still moves.
  freshStartup: CODEX_ACCOUNT_RESTART_STARTUP,
  transcriptAccountId: (transcriptPath) => resolveCodexSessionAccountId(transcriptPath),
  launchAccountId: (snapshot) => snapshot.accountId ?? null,
  accountLabel: (snapshot) =>
    resolveCodexSwitchAccountLabel(snapshot.state.accounts, snapshot.accountId),
  isAgentForeground: (reading, launchAgent) =>
    isCodexRestartEligiblePane({ inspection: reading, launchAgent }),
  copy: {
    body: (values) =>
      values.count === 1
        ? translate(
            'accounts.switchSessions.codex.bodyOne',
            '1 Codex session is still running on {{previous}}. Restarting relaunches it on {{next}}. A busy session waits for idle before restarting.',
            values
          )
        : translate(
            'accounts.switchSessions.codex.bodyOther',
            '{{count}} Codex sessions are still running on {{previous}}. Restarting relaunches them on {{next}}. Busy sessions wait for idle before restarting.',
            values
          ),
    settingTitle: () =>
      translate(
        'accounts.switchSessions.codex.settingTitle',
        'When you switch accounts while Codex is running'
      ),
    settingDescription: () =>
      translate(
        'accounts.switchSessions.codex.settingDescription',
        'Restarting relaunches each running Codex session on the new account.'
      )
  }
}
