import { useState } from 'react'
import { Copy } from 'lucide-react'
import { toast } from 'sonner'
import { classifyRemotePairingHostname } from '../../../../../../shared/remote-runtime/pairing/remote-pairing-address'
import type { RemoteServerUpdateEntry } from '@/runtime/hosts/updates/remote-server-update-coordinator'
import { useTranslate } from '@/i18n/use-translate'
import { Button } from '../../../ui/button'
import {
  getHostModelCapabilitySummary,
  getRuntimeCapabilitiesSummary,
  type RuntimeHostDetails
} from '../catalog/runtime-environment-host-details'
import { getRemoteServerManualUpdateHelp } from '../updates/RemoteServerUpdateStatus'

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
  const t = useTranslate()
  // Lead with explanatory copy; keep raw diagnostic errors collapsed for copying.
  const [errorOpen, setErrorOpen] = useState(false)
  const runtimeStatus = details?.runtimeStatus ?? null
  const hostModelSummary = getHostModelCapabilitySummary(runtimeStatus, t)
  const updateError = remoteUpdate?.phase === 'failed' ? remoteUpdate.error : null
  const rawError = [problem, updateError].filter(Boolean).join('\n')
  const kind = unreachable ? endpointKind(endpoint) : null
  const lead = unreachable
    ? t('auto.components.settings.serverList.unreachableLead', 'Orca couldn’t reach this server.')
    : updateError
      ? t('auto.components.settings.serverList.updateFailedLead', 'The last update didn’t finish.')
      : null
  return (
    <div className="space-y-2 rounded-md border border-border bg-muted/30 px-3 py-2.5 text-xs">
      {lead ? <p className="text-foreground">{lead}</p> : null}
      {unreachable ? (
        <p className="text-muted-foreground">
          {t(
            'auto.components.settings.serverList.unreachableHint',
            'Check that Orca is running on the server and that this computer can reach its address.'
          )}
          {kind === 'tailscale'
            ? ` ${t(
                'auto.components.settings.serverList.tailscaleTip',
                'This is a Tailscale address, so both computers need to be signed in to the same tailnet.'
              )}`
            : kind === 'loopback'
              ? ` ${t(
                  'auto.components.settings.serverList.loopbackTip',
                  'A 127.0.0.1 address works only through an SSH tunnel.'
                )}`
              : ''}
        </p>
      ) : null}
      {remoteUpdate?.phase === 'manual' ? (
        <p className="text-muted-foreground">{getRemoteServerManualUpdateHelp(remoteUpdate, t)}</p>
      ) : null}
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-muted-foreground">
        <dt>{t('auto.components.settings.serverList.address', 'Address')}</dt>
        <dd className="truncate font-mono text-foreground">
          {endpoint ??
            t('auto.components.settings.RuntimeEnvironmentsPane.6ef71985da', 'No endpoint')}
        </dd>
        {sshRoute ? (
          <>
            <dt>{t('auto.components.settings.serverList.route', 'Route')}</dt>
            <dd className="truncate text-foreground">{sshRoute}</dd>
          </>
        ) : null}
        {runtimeStatus ? (
          <>
            <dt>{t('auto.components.settings.serverList.protocol', 'Protocol')}</dt>
            <dd className="truncate text-foreground">
              {runtimeStatus.runtimeProtocolVersion ?? runtimeStatus.protocolVersion ?? 0}
              {runtimeStatus.hostPlatform ? ` · ${runtimeStatus.hostPlatform}` : ''}
            </dd>
            <dt>{t('auto.components.settings.serverList.capabilities', 'Capabilities')}</dt>
            <dd className="truncate text-foreground">
              {getRuntimeCapabilitiesSummary(runtimeStatus, t)}
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
                ? t('auto.components.settings.serverList.hideError', 'Hide error')
                : t('auto.components.settings.serverList.showError', 'Show error')}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="xs"
              onClick={() => {
                void window.api.ui.writeClipboardText(rawError).then(
                  () =>
                    toast.success(t('auto.components.settings.serverList.copied', 'Error copied')),
                  () =>
                    toast.error(
                      t(
                        'auto.components.settings.serverList.copyFailed',
                        'Couldn’t copy the error.'
                      )
                    )
                )
              }}
            >
              <Copy />
              {t('auto.components.settings.serverList.copyError', 'Copy error')}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  )
}
