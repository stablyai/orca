// Copy for S0 (agent-accounts spec §5, §10) and the composer's Agent row (cloud-start G).
// Catalog names only ("Claude", "Codex"); the vendor account for Codex is a ChatGPT account.
import type { Translate } from '@/i18n/use-translate'
import type {
  AgentKeyKind,
  OrcaCloudAccountAgent,
  OrcaCloudAgentSetupFailure
} from '../../../../../shared/orca-cloud-agents/orca-cloud-agents-wire'

export function agentName(agent: OrcaCloudAccountAgent, t: Translate): string {
  return agent === 'claude'
    ? t('orcaCloudAccounts.agent.claude', 'Claude')
    : t('orcaCloudAccounts.agent.codex', 'Codex')
}

/** The vendor account behind the agent: Claude for Claude, ChatGPT for Codex. */
export function productName(agent: OrcaCloudAccountAgent, t: Translate): string {
  return agent === 'claude'
    ? t('orcaCloudAccounts.product.claude', 'Claude')
    : t('orcaCloudAccounts.product.codex', 'ChatGPT')
}

/** "team key" / "repository key" / "your API key", lower case for use mid-sentence. */
export function keyPhrase(kind: AgentKeyKind, t: Translate): string {
  switch (kind) {
    case 'team':
      return t('orcaCloudAccounts.key.team', 'the team key')
    case 'repository':
      return t('orcaCloudAccounts.key.repository', 'the repository key')
    case 'personal':
      return t('orcaCloudAccounts.key.personal', 'your API key')
  }
}

/** The Source option for the key, sentence case. */
export function keyOptionLabel(kind: AgentKeyKind, t: Translate): string {
  switch (kind) {
    case 'team':
      return t('orcaCloudAccounts.source.teamKey', 'Team key')
    case 'repository':
      return t('orcaCloudAccounts.source.repositoryKey', 'Repository key')
    case 'personal':
      return t('orcaCloudAccounts.source.ownKey', 'Your API key')
  }
}

/** "Keep the team key" for state 7. */
export function keepKeyLabel(kind: AgentKeyKind, t: Translate): string {
  switch (kind) {
    case 'team':
      return t('orcaCloudAccounts.keepTeam', 'Keep the team key')
    case 'repository':
      return t('orcaCloudAccounts.keepRepository', 'Keep the repository key')
    case 'personal':
      return t('orcaCloudAccounts.keepOwn', 'Keep your API key')
  }
}

/** "Claude · team key" in the composer's Agent row (glossary "Agent source"). */
export function keySourceLabel(kind: AgentKeyKind, t: Translate): string {
  switch (kind) {
    case 'team':
      return t('orcaCloudAccounts.via.team', 'team key')
    case 'repository':
      return t('orcaCloudAccounts.via.repository', 'repository key')
    case 'personal':
      return t('orcaCloudAccounts.via.personal', 'your API key')
  }
}

export function setupFailureCopy(
  agent: OrcaCloudAccountAgent,
  error: OrcaCloudAgentSetupFailure,
  t: Translate
): { title: string; detail: string | null } {
  const product = productName(agent, t)
  const nothingChanged = t('orcaCloudAccounts.error.nothingChanged', 'Nothing was changed.')
  switch (error) {
    case 'denied':
      return {
        title: t('orcaCloudAccounts.error.denied', 'The sign-in was declined in your browser.'),
        detail: nothingChanged
      }
    case 'timed_out':
      return {
        title: t('orcaCloudAccounts.error.timedOut', 'The sign-in took too long to finish.'),
        detail: nothingChanged
      }
    case 'code_expired':
      return {
        title: t('orcaCloudAccounts.error.codeExpired', 'The code expired · start again'),
        detail: null
      }
    case 'not_a_chatgpt_login':
      return {
        title: t(
          'orcaCloudAccounts.error.notChatGpt',
          'That sign-in wasn’t a ChatGPT account. Use the ChatGPT account you use with Codex.'
        ),
        detail: nothingChanged
      }
    case 'broker_in_progress':
      return {
        title: t(
          'orcaCloudAccounts.error.brokerBusy',
          'A ChatGPT sign-in is already running. Finish it, or try again in a minute.'
        ),
        detail: null
      }
    case 'rate_limited':
      return {
        title: t(
          'orcaCloudAccounts.error.rateLimited',
          'Too many sign-in attempts. Try again in a few minutes.'
        ),
        detail: nothingChanged
      }
    case 'device_auth_disabled':
      // RS-3: the broker started but ChatGPT refused to issue a device code for this account.
      return {
        title: t(
          'orcaCloudAccounts.error.deviceAuthDisabled',
          'Device code sign-in is turned off for this ChatGPT account.'
        ),
        detail: t(
          'orcaCloudAccounts.error.deviceAuthDisabledDetail',
          'Turn on device code sign-in for Codex in ChatGPT’s security settings, then try again.'
        )
      }
    case 'invalid_token':
      return {
        title: t(
          'orcaCloudAccounts.error.invalidToken',
          'This token isn’t valid · run claude setup-token again'
        ),
        detail: null
      }
    case 'invalid_code':
      return {
        title: t(
          'agentSignInStrip.setupCodeRejected',
          'That code didn’t work. Paste the newest code from the sign-in page, or open it again.'
        ),
        detail: null
      }
    case 'not_found':
    case 'not_enabled':
      return {
        title: t(
          'orcaCloudAccounts.error.notEnabled',
          'Orca can’t use your {{product}} account in cloud workspaces right now.',
          { product }
        ),
        detail: nothingChanged
      }
    case 'signed_out':
      return {
        title: t('orcaCloudAccounts.error.signedOut', 'Sign in to Orca again, then try again.'),
        detail: nothingChanged
      }
    case 'no_cli':
    case 'capture_failed':
    case 'store_failed':
    case 'broker_unavailable':
    case 'no_golden_image':
    case 'not_configured':
    case 'timeout':
    case 'unavailable':
    case 'unknown':
      return {
        title: t('orcaCloudAccounts.error.saveFailed', 'Couldn’t save to your Orca account.'),
        detail: nothingChanged
      }
  }
}
