import { Check, Cloud, Loader2, LogIn, LogOut, Plus } from 'lucide-react'
import {
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger
} from '@/components/ui/dropdown-menu'
import { translate } from '@/i18n/i18n'
import type {
  OrcaCloudOrgSummary,
  OrcaProfileAuthStatus,
  OrcaProfileSummary
} from '../../../../shared/orca-profiles'

function getConnectLabel(authStatus: OrcaProfileAuthStatus | null, connecting: boolean): string {
  if (connecting) {
    return translate('auto.components.orca.profiles.switcher.signInWaiting', 'Waiting for sign-in…')
  }
  if (authStatus?.configured !== true) {
    return translate(
      'auto.components.orca.profiles.switcher.cloud.unavailable',
      'Orca sign-in unavailable'
    )
  }
  if (authStatus.state === 'reconnect-required') {
    return translate('auto.components.orca.profiles.switcher.signInAgain', 'Sign in again')
  }
  return translate('auto.components.orca.profiles.switcher.signIn', 'Sign in to Orca')
}

export function OrcaProfileCloudMenuItems({
  activeProfile,
  authStatus,
  connecting,
  profileActionDisabled,
  allowProfileCreation,
  separateAuthActions,
  onConnect,
  onCreateProfileForOrg,
  onSelectOrg,
  onRequestSignOut
}: {
  activeProfile: OrcaProfileSummary
  authStatus: OrcaProfileAuthStatus | null
  connecting: boolean
  profileActionDisabled: boolean
  allowProfileCreation: boolean
  separateAuthActions: boolean
  onConnect: () => void
  onCreateProfileForOrg: (organization: OrcaCloudOrgSummary) => void
  onSelectOrg: (orgId: string) => void
  onRequestSignOut: () => void
}): React.JSX.Element {
  const cloudConfigured = authStatus?.configured === true
  const organizations = authStatus?.organizations ?? []
  const showOrganizationChoices = activeProfile.kind === 'cloud-linked' && organizations.length > 1
  // Why: profile creation is hidden in the downscoped account menu, so the
  // "Create profile for org" submenu only appears when multi-profile UI is on.
  const showCloudProfileCreation =
    allowProfileCreation && activeProfile.kind === 'cloud-linked' && organizations.length > 0
  const orgActionDisabled = profileActionDisabled || authStatus?.state !== 'connected'
  const activeOrgId = activeProfile.cloud?.activeOrgId
  const showSignIn = authStatus?.state !== 'connected'

  return (
    <>
      {showOrganizationChoices || showCloudProfileCreation ? (
        <>
          <DropdownMenuSeparator />
          <DropdownMenuLabel>
            {translate('auto.components.orca.profiles.switcher.organization', 'Organization')}
          </DropdownMenuLabel>
          {showOrganizationChoices
            ? organizations.map((organization) => (
                <DropdownMenuItem
                  key={organization.orgId}
                  disabled={orgActionDisabled}
                  onSelect={() => {
                    if (organization.orgId !== activeOrgId) {
                      onSelectOrg(organization.orgId)
                    }
                  }}
                  className="min-w-0"
                >
                  <Cloud />
                  <span className="min-w-0 flex-1 truncate">{organization.name}</span>
                  {organization.orgId === activeOrgId ? <Check className="size-3.5" /> : null}
                </DropdownMenuItem>
              ))
            : null}
          {showCloudProfileCreation ? (
            <DropdownMenuSub>
              <DropdownMenuSubTrigger disabled={orgActionDisabled}>
                <Plus />
                {translate(
                  'auto.components.orca.profiles.switcher.create.profile.for.org',
                  'Create profile for org'
                )}
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="w-48">
                {organizations.map((organization) => (
                  <DropdownMenuItem
                    key={organization.orgId}
                    onSelect={() => onCreateProfileForOrg(organization)}
                    className="min-w-0"
                  >
                    <Cloud />
                    <span className="min-w-0 flex-1 truncate">{organization.name}</span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          ) : null}
        </>
      ) : null}

      {separateAuthActions || showOrganizationChoices || showCloudProfileCreation ? (
        <DropdownMenuSeparator />
      ) : null}
      {showSignIn ? (
        <DropdownMenuItem disabled={profileActionDisabled || !cloudConfigured} onSelect={onConnect}>
          {connecting ? <Loader2 className="size-4 animate-spin" /> : <LogIn />}
          {getConnectLabel(authStatus, connecting)}
        </DropdownMenuItem>
      ) : null}
      {activeProfile.kind === 'cloud-linked' ? (
        <DropdownMenuItem disabled={profileActionDisabled} onSelect={onRequestSignOut}>
          <LogOut />
          {translate('auto.components.orca.profiles.switcher.signout', 'Sign out')}
        </DropdownMenuItem>
      ) : null}
    </>
  )
}
