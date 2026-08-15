import { useEffect, useState } from 'react'
import { Check, CircleUserRound, Files, Smartphone } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { OrcaProfileSignOutConfirmDialog } from '../orca-profiles/OrcaProfileSignOutConfirmDialog'

function accountStatusCopy(
  state: 'local' | 'unconfigured' | 'connected' | 'reconnect-required' | undefined,
  email: string | undefined
): string {
  if (state === 'connected') {
    return email ?? translate('auto.components.settings.orcaAccount.connected', 'Connected')
  }
  if (state === 'reconnect-required') {
    return translate(
      'auto.components.settings.orcaAccount.reconnectRequired',
      'Your session expired. Sign in again to use cloud features.'
    )
  }
  if (state === 'unconfigured') {
    return translate(
      'auto.components.settings.orcaAccount.unavailable',
      'Orca sign-in is unavailable in this build.'
    )
  }
  if (state === 'local') {
    return translate(
      'auto.components.settings.orcaAccount.signedOut',
      'Sign in to extend Orca with cloud features, including Artifacts and Orca Relay.'
    )
  }
  return translate('auto.components.settings.orcaAccount.checking', 'Checking account status…')
}

export function OrcaAccountSettingsPane(): React.JSX.Element {
  const authStatus = useAppStore((state) => state.orcaProfileAuthStatus)
  const connecting = useAppStore((state) => state.orcaProfileConnecting)
  const connect = useAppStore((state) => state.connectCurrentOrcaProfile)
  const fetchAuthStatus = useAppStore((state) => state.fetchOrcaProfileAuthStatus)
  const signOut = useAppStore((state) => state.signOutCurrentOrcaProfile)
  const [signOutOpen, setSignOutOpen] = useState(false)
  const [signingOut, setSigningOut] = useState(false)
  const connected = authStatus?.state === 'connected'
  const canConnect = authStatus?.configured === true

  useEffect(() => {
    if (!authStatus) {
      void fetchAuthStatus()
    }
  }, [authStatus, fetchAuthStatus])

  const confirmSignOut = async (): Promise<void> => {
    if (signingOut) {
      return
    }
    setSigningOut(true)
    const result = await signOut()
    setSigningOut(false)
    if (result) {
      setSignOutOpen(false)
    }
  }

  return (
    <>
      <div className="space-y-6">
        <div className="flex flex-wrap items-center gap-4">
          <div className="flex size-11 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
            <CircleUserRound className="size-5" />
          </div>
          <div className="min-w-0 flex-1 space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-sm font-medium">
                {authStatus?.cloud?.displayName?.trim() ||
                  translate('auto.components.settings.orcaAccount.account', 'Orca account')}
              </p>
              {connected ? (
                <Badge variant="outline" className="text-[11px] text-muted-foreground">
                  <Check />
                  {translate('auto.components.settings.orcaAccount.connected', 'Connected')}
                </Badge>
              ) : null}
            </div>
            <p className="truncate text-xs text-muted-foreground">
              {accountStatusCopy(authStatus?.state, authStatus?.cloud?.email)}
            </p>
          </div>
          {connected ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={signingOut}
              onClick={() => setSignOutOpen(true)}
            >
              {translate('auto.components.settings.orcaAccount.signOut', 'Sign out')}
            </Button>
          ) : (
            <Button
              type="button"
              size="sm"
              disabled={!canConnect || connecting}
              onClick={() => void connect()}
            >
              {connecting
                ? translate('auto.components.settings.orcaAccount.signingIn', 'Signing in…')
                : authStatus?.state === 'reconnect-required'
                  ? translate('auto.components.settings.orcaAccount.signInAgain', 'Sign in again')
                  : translate('auto.components.settings.orcaAccount.signIn', 'Sign in to Orca')}
            </Button>
          )}
        </div>

        <div className="space-y-4 border-t border-border/60 pt-5">
          <p className="text-[11px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
            {translate(
              'auto.components.settings.orcaAccount.benefitsTitle',
              'Included with your account'
            )}
          </p>
          <div className="grid gap-5 md:grid-cols-2 md:gap-0 md:divide-x md:divide-border/60">
            <div className="flex items-start gap-3 md:pr-6">
              <Files className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <div className="space-y-1">
                <p className="text-sm font-medium">
                  {translate(
                    'auto.components.settings.orcaAccount.artifactsTitle',
                    'Artifact sharing'
                  )}
                </p>
                <p className="text-xs leading-5 text-muted-foreground">
                  {translate(
                    'auto.components.settings.orcaAccount.artifactsDescription',
                    'Publish HTML and Markdown files, then manage every shared link from Orca.'
                  )}
                </p>
              </div>
            </div>
            <div className="flex items-start gap-3 md:pl-6">
              <Smartphone className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <div className="space-y-1">
                <p className="text-sm font-medium">
                  {translate('auto.components.settings.orcaAccount.relayTitle', 'Orca Relay')}
                </p>
                <p className="text-xs leading-5 text-muted-foreground">
                  {translate(
                    'auto.components.settings.orcaAccount.relayDescription',
                    'Connect Orca Mobile to this desktop across cellular or any Wi-Fi.'
                  )}
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>

      <OrcaProfileSignOutConfirmDialog
        open={signOutOpen}
        onOpenChange={setSignOutOpen}
        onConfirm={() => void confirmSignOut()}
        signingOut={signingOut}
      />
    </>
  )
}
