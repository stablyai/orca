import { translate } from '../../i18n/i18n'
import { useAppStore } from '../../store'
import { OrcaSignInButton, OrcaSignInWaitNotice } from '../OrcaSignInProgress'

export function MobileRelaySignInPanel({
  reconnectRequired
}: {
  reconnectRequired: boolean
}): React.JSX.Element {
  const browserWaiting = useAppStore((state) => Boolean(state.orcaProfileSignInProgress?.link))

  return (
    <div
      // Why role-less: a radiogroup may only own radios; this div is layout under the Relay radio.
      onKeyDown={(event) => {
        // Why: arrow keys on nested controls must not change the selected path.
        if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) {
          event.stopPropagation()
        }
      }}
      className="flex flex-wrap items-center justify-between gap-2 border-t border-border/60 bg-accent/40 py-2.5 pl-10 pr-3"
      data-testid="anywhere-sign-in-panel"
    >
      {browserWaiting ? (
        <OrcaSignInWaitNotice className="min-w-0 flex-1" />
      ) : (
        <p className="min-w-0 flex-1 text-xs text-muted-foreground">
          {translate(
            'auto.components.settings.MobilePairingConnectionOptions.relaySignInDetail',
            'Signs this desktop in to Orca and routes the phone through Orca’s servers. LAN does not need an account.'
          )}
        </p>
      )}
      <OrcaSignInButton size="sm" className="shrink-0">
        {reconnectRequired
          ? translate(
              'auto.components.settings.MobilePairingConnectionOptions.signInAgain',
              'Sign in again for Relay'
            )
          : translate(
              'auto.components.settings.MobilePairingConnectionOptions.signIn',
              'Sign in for Relay'
            )}
      </OrcaSignInButton>
    </div>
  )
}
