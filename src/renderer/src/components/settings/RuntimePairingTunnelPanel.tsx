import type { TailcatTunnelStatus } from '../../../../shared/tailcat-tunnel-status'
import { translate } from '@/i18n/i18n'

/** Explains the Tailcat option: whether the CLI is installed and whether this host's tunnel is up. */
export function RuntimePairingTunnelPanel({
  status
}: {
  status: TailcatTunnelStatus | null
}): React.JSX.Element {
  const serverState = status?.server.state ?? 'stopped'
  return (
    <div className="rounded-md border border-border/60 bg-muted/30 p-3 text-xs">
      <div className="font-medium">
        {translate(
          'auto.components.settings.RuntimePairingUrlGenerator.tunnelTitle',
          'Tailcat tunnel'
        )}
      </div>
      {status === null ? (
        <p className="mt-1 text-muted-foreground">
          {translate(
            'auto.components.settings.RuntimePairingUrlGenerator.tunnelChecking',
            'Checking for the tailcat CLI…'
          )}
        </p>
      ) : !status.installed ? (
        <p role="alert" className="mt-1 text-destructive">
          {translate(
            'auto.components.settings.RuntimePairingUrlGenerator.tunnelMissing',
            'The tailcat CLI was not found on this computer. {{hint}}',
            { hint: status.installHint }
          )}
        </p>
      ) : status.compatible === false ? (
        <p role="alert" className="mt-1 text-destructive">
          {translate(
            'auto.components.settings.RuntimePairingUrlGenerator.tunnelIncompatible',
            'This tailcat build cannot be used: {{reason}}',
            { reason: status.incompatibleReason ?? '' }
          )}
        </p>
      ) : (
        <>
          <p className="mt-1 text-muted-foreground">
            {translate(
              'auto.components.settings.RuntimePairingUrlGenerator.tunnelHelp',
              'The link carries this computer’s tunnel address, so the other Orca reaches it from any network. It needs the tailcat CLI installed too.'
            )}
          </p>
          <p className="mt-1 text-muted-foreground">
            {serverState === 'running'
              ? translate(
                  'auto.components.settings.RuntimePairingUrlGenerator.tunnelRunning',
                  'Tunnel running.'
                )
              : serverState === 'starting'
                ? translate(
                    'auto.components.settings.RuntimePairingUrlGenerator.tunnelStarting',
                    'Tunnel starting…'
                  )
                : serverState === 'failed'
                  ? translate(
                      'auto.components.settings.RuntimePairingUrlGenerator.tunnelFailed',
                      'The tunnel failed to start. Generating a link tries again.'
                    )
                  : translate(
                      'auto.components.settings.RuntimePairingUrlGenerator.tunnelIdle',
                      'The tunnel starts when you generate a link.'
                    )}
          </p>
        </>
      )}
    </div>
  )
}
