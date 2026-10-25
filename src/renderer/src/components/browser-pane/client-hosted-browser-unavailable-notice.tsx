import { useEffect } from 'react'
import { Globe } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { readBrowserClientHostId } from '@/runtime/browser-client-host-identity'
import { runtimeHostConnectionStateForEntry } from '@/runtime/runtime-host-connection-state'
import { ensureBrowserClientHostOnRuntimeContact } from '@/runtime/restored-client-hosted-browser-host-attach'
import {
  isRuntimeHostContactRevokedVerdict,
  runtimeHostContactForEntry
} from '../../../../shared/runtime-host-contact'
import {
  ReopenBrowserPageOnServerButton,
  reopenOnServerCaveat
} from './ReopenBrowserPageOnServerButton'
import { BROWSER_SCREENCAST_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'

/** No guest exists here to retry; offer reopening on a capable server when hosting is unavailable or belongs to another desktop. */
export function ClientHostedBrowserUnavailableNotice({
  runtimeEnvironmentId,
  worktreeId,
  lastCommittedUrl,
  placementHostClientId
}: {
  runtimeEnvironmentId: string
  worktreeId: string
  lastCommittedUrl: string
  placementHostClientId: string | null
}): React.JSX.Element {
  const offlineHostName = useAppStore((s) => {
    const entry = s.runtimeStatusByEnvironmentId.get(runtimeEnvironmentId)
    const state = runtimeHostConnectionStateForEntry(entry)
    // Revoked/refused pairings also read disconnected but cannot reconnect.
    const offline =
      (state === 'reconnecting' || state === 'disconnected') &&
      !isRuntimeHostContactRevokedVerdict(runtimeHostContactForEntry(entry))
    return offline
      ? (s.runtimeEnvironments.find((environment) => environment.id === runtimeEnvironmentId)
          ?.name ?? null)
      : null
  })
  // Why: a runtime known to have no browser of its own (orcad) cannot take the page back.
  const runtimeCanHostPage = useAppStore((s) => {
    const capabilities =
      s.runtimeStatusByEnvironmentId.get(runtimeEnvironmentId)?.status?.capabilities
    return !capabilities || capabilities.includes(BROWSER_SCREENCAST_RUNTIME_CAPABILITY)
  })
  const ownHostClientId = readBrowserClientHostId()
  const onOtherDesktop = Boolean(
    placementHostClientId && ownHostClientId && placementHostClientId !== ownHostClientId
  )
  // Reclaim hosting on mount too; a failed lease reconnect after contact returns has no later contact edge.
  useEffect(() => {
    const state = useAppStore.getState()
    if (!onOtherDesktop && state.runtimeStatusByEnvironmentId.get(runtimeEnvironmentId)?.status) {
      void ensureBrowserClientHostOnRuntimeContact(state, runtimeEnvironmentId)
    }
  }, [onOtherDesktop, runtimeEnvironmentId])
  const description = onOtherDesktop
    ? translate(
        'browser.clientHosted.unavailableOtherDesktopDescription',
        'This page is open on another desktop.'
      )
    : offlineHostName
      ? translate(
          'browser.clientHosted.unavailableHostOfflineDescription',
          '{{host}} is offline. This page will reload here once it reconnects.',
          { host: offlineHostName }
        )
      : translate(
          'browser.clientHosted.unavailableDescription',
          "This page isn't available on this desktop right now."
        )
  return (
    <div className="absolute inset-0 flex items-center justify-center px-6 text-center">
      <div className="flex max-w-sm flex-col items-center gap-2">
        <Globe className="size-5 text-muted-foreground" />
        <div className="text-sm font-medium text-foreground">
          {translate('browser.clientHosted.unavailableTitle', 'Client-hosted browser unavailable')}
        </div>
        <div className="text-xs leading-5 text-muted-foreground">{description}</div>
        {runtimeCanHostPage ? (
          <>
            <div className="text-xs leading-5 text-muted-foreground">{reopenOnServerCaveat()}</div>
            <ReopenBrowserPageOnServerButton
              environmentId={runtimeEnvironmentId}
              worktreeId={worktreeId}
              lastCommittedUrl={lastCommittedUrl}
            />
          </>
        ) : null}
      </div>
    </div>
  )
}
