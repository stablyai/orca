// Orca Cloud additions to the Orca account pane: the cloud-only rows, the SSO status line, and
// hiding the account-benefits list (Orca Cloud has its own settings entries beside this page).
import type React from 'react'
import { useOrcaCloudApiAvailable } from '@/hooks/useOrcaCloudApiAvailability'
import type { Translate } from '@/i18n/use-translate'
import type { OrcaProfileAuthStatus } from '../../../../../../shared/orca-profiles/orca-profiles'
import { AccountMfaRow } from './AccountMfaRow'
import { AccountTeamAdminRow } from './AccountTeamAdminRow'
import { GitHubIdentityRow } from './GitHubIdentityRow'

/** The status line when the team now requires SSO; null leaves the line to the account pane. */
export function orcaCloudAccountStatusCopy(
  authStatus: OrcaProfileAuthStatus | null | undefined,
  t: Translate
): string | null {
  if (authStatus?.state === 'reconnect-required' && authStatus.reconnectReason === 'sso-required') {
    return t(
      'auto.components.settings.orcaAccount.ssoRequired',
      'Your team now requires single sign-on. Sign in again and choose Sign in with SSO.'
    )
  }
  return null
}

/** The rows only a person signed in to Orca Cloud sees. */
export function OrcaAccountCloudRows({
  connected
}: {
  connected: boolean
}): React.JSX.Element | null {
  const cloudAvailable = useOrcaCloudApiAvailable()
  if (!connected || !cloudAvailable) {
    return null
  }
  return (
    <>
      {/* The person's own GitHub for cloud commits; only signed in to Orca Cloud. */}
      <GitHubIdentityRow />
      {/* Their own second factor: status, and a link to the account page that manages it. */}
      <AccountMfaRow />
      {/* Team, billing and admin are managed in the web console; this row is the way there. */}
      <AccountTeamAdminRow />
    </>
  )
}

/**
 * With Orca Cloud the page is identity + Sign out (and the console row); agents and the rest of
 * Orca Cloud have their own entries in the group right beside it, so the benefits list hides.
 */
export function HiddenWithOrcaCloud({
  children
}: {
  children: React.ReactNode
}): React.JSX.Element | null {
  return useOrcaCloudApiAvailable() ? null : <>{children}</>
}
