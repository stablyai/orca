import { useEffect, useState } from 'react'
import { BookOpen, Check, CircleUserRound, Files, Smartphone } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { MCodeProfileSignOutConfirmDialog } from '../mcode-profiles/MCodeProfileSignOutConfirmDialog'

function accountStatusCopy(
  state: 'local' | 'unconfigured' | 'connected' | 'reconnect-required' | undefined,
  email: string | undefined
): string {
  if (state === 'connected') {
    return email ?? translate('auto.components.settings.mcodeAccount.connected', 'Connected')
  }
  if (state === 'reconnect-required') {
    return translate(
      'auto.components.settings.mcodeAccount.reconnectRequired',
      'Your session expired. Sign in again to use cloud features.'
    )
  }
  if (state === 'unconfigured') {
    return translate(
      'auto.components.settings.mcodeAccount.unavailable',
      'MCode sign-in is unavailable in this build.'
    )
  }
  if (state === 'local') {
    return translate(
      'auto.components.settings.mcodeAccount.signedOut',
      'Sign in to extend MCode with cloud features, including Artifacts and MCode Relay.'
    )
  }
  return translate('auto.components.settings.mcodeAccount.checking', 'Checking account status…')
}

function AccountBenefit({
  icon: Icon,
  title,
  description,
  className
}: {
  icon: typeof Files
  title: string
  description: string
  className?: string
}): React.JSX.Element {
  return (
    <div className={cn('flex items-start gap-3', className)}>
      <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <div className="space-y-1">
        <p className="text-sm font-medium">{title}</p>
        <p className="text-xs leading-5 text-muted-foreground">{description}</p>
      </div>
    </div>
  )
}

export function MCodeAccountSettingsPane(): React.JSX.Element {
  const authStatus = useAppStore((state) => state.mcodeProfileAuthStatus)
  const connecting = useAppStore((state) => state.mcodeProfileConnecting)
  const connect = useAppStore((state) => state.connectCurrentMCodeProfile)
  const fetchAuthStatus = useAppStore((state) => state.fetchMCodeProfileAuthStatus)
  const signOut = useAppStore((state) => state.signOutCurrentMCodeProfile)
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
                  translate('auto.components.settings.mcodeAccount.account', 'MCode account')}
              </p>
              {connected ? (
                <Badge variant="outline" className="text-[11px] text-muted-foreground">
                  <Check />
                  {translate('auto.components.settings.mcodeAccount.connected', 'Connected')}
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
              {translate('auto.components.settings.mcodeAccount.signOut', 'Sign out')}
            </Button>
          ) : (
            <Button
              type="button"
              size="sm"
              disabled={!canConnect || connecting}
              onClick={() => void connect()}
            >
              {connecting
                ? translate('auto.components.settings.mcodeAccount.signingIn', 'Signing in…')
                : authStatus?.state === 'reconnect-required'
                  ? translate('auto.components.settings.mcodeAccount.signInAgain', 'Sign in again')
                  : translate('auto.components.settings.mcodeAccount.signIn', 'Sign in to MCode')}
            </Button>
          )}
        </div>

        <div className="space-y-4 border-t border-border/60 pt-5">
          <p className="text-[11px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
            {translate(
              'auto.components.settings.mcodeAccount.benefitsTitle',
              'Included with your account'
            )}
          </p>
          <div className="space-y-5">
            <div className="grid gap-5 md:grid-cols-2 md:gap-0 md:divide-x md:divide-border/60">
              <AccountBenefit
                icon={Files}
                className="md:pr-6"
                title={translate(
                  'auto.components.settings.mcodeAccount.artifactsTitle',
                  'Artifact sharing'
                )}
                description={translate(
                  'auto.components.settings.mcodeAccount.artifactsDescription',
                  'Publish HTML and Markdown files, then manage every shared link from MCode.'
                )}
              />
              <AccountBenefit
                icon={Smartphone}
                className="md:pl-6"
                title={translate('auto.components.settings.mcodeAccount.relayTitle', 'MCode Relay')}
                description={translate(
                  'auto.components.settings.mcodeAccount.relayDescription',
                  'Connect MCode Mobile to this desktop across cellular or any Wi-Fi.'
                )}
              />
            </div>
            {/* Why: a third column would squeeze all three; a full-width row
                below keeps the pair's divider and reads as one list. */}
            <AccountBenefit
              icon={BookOpen}
              className="border-t border-border/60 pt-5"
              title={translate('auto.components.settings.mcodeAccount.skillsTitle', 'Skill sharing')}
              description={translate(
                'auto.components.settings.mcodeAccount.skillsDescription',
                'Share one skill or a whole set behind an unlisted link, and install them on any machine you use.'
              )}
            />
          </div>
        </div>
      </div>

      <MCodeProfileSignOutConfirmDialog
        open={signOutOpen}
        onOpenChange={setSignOutOpen}
        onConfirm={() => void confirmSignOut()}
        signingOut={signingOut}
      />
    </>
  )
}
