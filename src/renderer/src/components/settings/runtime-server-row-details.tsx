import { useState } from 'react'
import { Copy } from 'lucide-react'
import { toast } from 'sonner'
import { classifyRemotePairingHostname } from '../../../../shared/remote-pairing-address'
import type { RemoteServerUpdateEntry } from '@/runtime/remote-server-update-coordinator'
import { translate } from '@/i18n/i18n'
import { Button } from '../ui/button'
import {
  getHostModelCapabilitySummary,
  getRuntimeCapabilitiesSummary,
  type RuntimeHostDetails
} from './runtime-environment-host-details'
import { getRemoteServerManualUpdateHelp } from './RemoteServerUpdateStatus'

type RuntimeServerRowDetailsProps = {
  endpoint: string | null
  details: RuntimeHostDetails | undefined
  remoteUpdate: RemoteServerUpdateEntry | undefined
  /** The raw error, shown as-is for copying; the lead sentence explains it. */
  problem: string | null
  sshRoute: string | null
  unreachable: boolean
  children?: React.ReactNode
}

function endpointKind(
  endpoint: string | null
): ReturnType<typeof classifyRemotePairingHostname> | null {
  if (!endpoint) {
    return null
  }
  try {
    return classifyRemotePairingHostname(new URL(endpoint).hostname)
  } catch {
    return null
  }
}

export function RuntimeServerRowDetails({
  endpoint,
  details,
  remoteUpdate,
  problem,
  sshRoute,
  unreachable,
  children
}: RuntimeServerRowDetailsProps): React.JSX.Element {
  // Lead with explanatory copy; keep raw diagnostic errors collapsed for copying.
  const [errorOpen, setErrorOpen] = useState(false)
  const runtimeStatus = details?.runtimeStatus ?? null
  const hostModelSummary = getHostModelCapabilitySummary(runtimeStatus)
  const updateError = remoteUpdate?.phase === 'failed' ? remoteUpdate.error : null
  const rawError = [problem, updateError].filter(Boolean).join('\n')
  const kind = unreachable ? endpointKind(endpoint) : null
  const lead = unreachable
    ? translate(
        'auto.components.settings.serverList.unreachableLead',
        'Orca couldn’t reach this server.'
      )
    : updateError
      ? translate(
          'auto.components.settings.serverList.updateFailedLead',
          'The last update didn’t finish.'
        )
      : null
  return (
    <div className="space-y-2 rounded-md border border-border bg-muted/30 px-3 py-2.5 text-xs">
      {lead ? <p className="text-foreground">{lead}</p> : null}
      {unreachable ? (
        <p className="text-muted-foreground">
          {translate(
            'auto.components.settings.serverList.unreachableHint',
            'Check that Orca is running on the server and that this computer can reach its address.'
          )}
          {kind === 'tailscale'
            ? ` ${translate(
                'auto.components.settings.serverList.tailscaleTip',
                'This is a Tailscale address, so both computers need to be signed in to the same tailnet.'
              )}`
            : kind === 'loopback'
              ? ` ${translate(
                  'auto.components.settings.serverList.loopbackTip',
                  'A 127.0.0.1 address works only through an SSH tunnel.'
                )}`
              : ''}
        </p>
      ) : null}
      {remoteUpdate?.phase === 'manual' ? (
        <p className="text-muted-foreground">{getRemoteServerManualUpdateHelp(remoteUpdate)}</p>
      ) : null}
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-muted-foreground">
        <dt>{translate('auto.components.settings.serverList.address', 'Address')}</dt>
        <dd className="truncate font-mono text-foreground">
          {endpoint ??
            translate('auto.components.settings.RuntimeEnvironmentsPane.6ef71985da', 'No endpoint')}
        </dd>
        {sshRoute ? (
          <>
            <dt>{translate('auto.components.settings.serverList.route', 'Route')}</dt>
            <dd className="truncate text-foreground">{sshRoute}</dd>
          </>
        ) : null}
        {runtimeStatus ? (
          <>
            <dt>{translate('auto.components.settings.serverList.protocol', 'Protocol')}</dt>
            <dd className="truncate text-foreground">
              {runtimeStatus.runtimeProtocolVersion ?? runtimeStatus.protocolVersion ?? 0}
              {runtimeStatus.hostPlatform ? ` · ${runtimeStatus.hostPlatform}` : ''}
            </dd>
            <dt>{translate('auto.components.settings.serverList.capabilities', 'Capabilities')}</dt>
            <dd className="truncate text-foreground">
              {getRuntimeCapabilitiesSummary(runtimeStatus)}
            </dd>
          </>
        ) : null}
      </dl>
      {hostModelSummary ? <p className="text-muted-foreground">{hostModelSummary}</p> : null}
      {children}
      {rawError ? (
        <div className="space-y-1.5">
          {errorOpen ? (
            <pre className="max-h-32 overflow-y-auto whitespace-pre-wrap break-words rounded bg-muted px-2 py-1.5 font-mono text-2xs text-muted-foreground scrollbar-sleek">
              {rawError}
            </pre>
          ) : null}
          <div className="flex items-center gap-1">
            <Button
              type="button"
              variant="ghost"
              size="xs"
              aria-expanded={errorOpen}
              onClick={() => setErrorOpen((value) => !value)}
            >
              {errorOpen
                ? translate('auto.components.settings.serverList.hideError', 'Hide error')
                : translate('auto.components.settings.serverList.showError', 'Show error')}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="xs"
              onClick={() => {
                void window.api.ui.writeClipboardText(rawError).then(
                  () =>
                    toast.success(
                      translate('auto.components.settings.serverList.copied', 'Error copied')
                    ),
                  () =>
                    toast.error(
                      translate(
                        'auto.components.settings.serverList.copyFailed',
                        'Couldn’t copy the error.'
                      )
                    )
                )
              }}
            >
              <Copy />
              {translate('auto.components.settings.serverList.copyError', 'Copy error')}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  )
}
