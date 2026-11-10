// The environment check's agent sign-in row on Orca Cloud. A sandbox holds only placeholders, so its
// own `auth status` probe can't see an Orca-account sign-in: what the person sees comes from the
// account instead (agent-accounts spec, design-squad sweep). Non-cloud recipe VMs keep the host copy.
import type { Translate } from '@/i18n/use-translate'
import type { EnvironmentDoctorCheck } from '../../../../shared/environment-doctor-types'
import { isOrcaCloudAccountAgent } from '../../../../shared/orca-cloud-agents/orca-cloud-agents-wire'
import { orcaCloudAgentCoverage } from '@/lib/orca-cloud/orca-cloud-agent-accounts-model'
import type { OrcaCloudAgentAccountsState } from '@/lib/orca-cloud/orca-cloud-agent-accounts-store'

export type CloudAgentCheckCopy =
  /** Covered (or not known yet): nothing for the person to do, so no row. */
  { kind: 'hide' } | { kind: 'copy'; message: string; remediation: string }

const SIGN_IN_CODES = new Set(['agentSignedOut', 'agentSignInTimedOut'])

/** Null when this isn't a cloud agent sign-in check; the shared copy applies then. */
export function cloudAgentCheckCopy(
  check: EnvironmentDoctorCheck,
  accounts: Pick<OrcaCloudAgentAccountsState, 'load' | 'keyKinds'>,
  t: Translate
): CloudAgentCheckCopy | null {
  if (!check.code || !SIGN_IN_CODES.has(check.code)) {
    return null
  }
  const agent = check.params?.agent ?? ''
  const id = check.id.startsWith('agent.') ? check.id.slice('agent.'.length) : ''
  if (!isOrcaCloudAccountAgent(id)) {
    // API-key agents (Gemini, Cursor, Copilot, OpenCode): their keys come from Cloud secrets.
    return {
      kind: 'copy',
      message: t('cloudAgentCheck.keyAgentSignedOut', '{{agent}} isn’t signed in.', { agent }),
      remediation: t(
        'cloudAgentCheck.keyAgentFix',
        'Add its API key in Settings → Cloud secrets, or sign in when it starts in this workspace.'
      )
    }
  }
  // Until the account is read, say nothing rather than guess (the Agents row shows the state).
  if (accounts.load.kind !== 'ready') {
    return { kind: 'hide' }
  }
  const coverage = orcaCloudAgentCoverage(id, accounts.load.status, accounts.keyKinds[id])
  switch (coverage.kind) {
    case 'account':
    case 'key':
      return { kind: 'hide' }
    case 'notSetUp':
      return {
        kind: 'copy',
        message: t('cloudAgentCheck.notSetUp', '{{agent}} isn’t set up for Orca Cloud yet.', {
          agent
        }),
        remediation: t(
          'cloudAgentCheck.notSetUpFix',
          'Set it up once in Settings → Agent accounts. Every cloud workspace uses it.'
        )
      }
    case 'expired':
      return {
        kind: 'copy',
        message: t('cloudAgentCheck.expired', 'Your {{agent}} sign-in for Orca Cloud expired.', {
          agent
        }),
        remediation: t(
          'cloudAgentCheck.expiredFix',
          'Renew it once in Settings → Agent accounts. Every cloud workspace uses it.'
        )
      }
    // Nothing to set up: the per-workspace wording of the build sheet's Agents row.
    case 'killSwitch':
      return {
        kind: 'copy',
        message: t('cloudAgentCheck.signInHere', '{{agent}} isn’t signed in for this workspace.', {
          agent
        }),
        remediation: t(
          'cloudAgentCheck.pausedFix',
          'Orca account sign-in is paused. Sign in for this workspace; the sign-in stays with this workspace.'
        )
      }
    case 'unavailable':
      return {
        kind: 'copy',
        message: t('cloudAgentCheck.signInHere', '{{agent}} isn’t signed in for this workspace.', {
          agent
        }),
        remediation: t(
          'cloudAgentCheck.notOfferedFix',
          'Signs in for each cloud workspace for now. Sign in for this workspace; the sign-in stays with this workspace.'
        )
      }
  }
}
