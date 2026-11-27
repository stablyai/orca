import { useEffect } from 'react'
import { Globe } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'
import {
  useAppStoreWithHostStatuses,
  useRuntimeHostStatusSelector
} from '@/store/slices/runtime-status/views/use-runtime-status-view'
import { readRuntimeStatuses } from '@/store/slices/runtime-status/views/runtime-status-owner'
import { useAppStore } from '@/store'
import { readBrowserClientHostId } from '@/runtime/browser/client-hosting/browser-client-host-identity'
import { runtimeHostConnectionStateForEntry } from '@/runtime/hosts/connections/runtime-host-connection-state'
import { ensureBrowserClientHostOnRuntimeContact } from '@/runtime/browser/client-hosting/restored-client-hosted-browser-host-attach'
import {
  isRuntimeHostContactRevokedVerdict,
  runtimeHostContactForEntry
} from '../../../../../../shared/remote-runtime/host-status/runtime-host-contact'
import {
  ReopenBrowserPageOnServerButton,
  reopenOnServerCaveat
} from '../../navigate/reopen-on-server/ReopenBrowserPageOnServerButton'
import '../../../../../../shared/remote-runtime/protocol/protocol-version'
import { BROWSER_SCREENCAST_RUNTIME_CAPABILITY } from '../../../../../../shared/browser/runtime/browser-runtime-capabilities'

/** No guest exists here to retry; offer reopening on a capable server when hosting is unavailable or belongs to another desktop. */
export function ClientHostedBrowserUnavailableNotice({
  browserPageId,
  runtimeEnvironmentId,
  worktreeId,
  reopenUrl,
  placementHostClientId
}: {
  browserPageId: string
  runtimeEnvironmentId: string
  worktreeId: string
  reopenUrl: string
  placementHostClientId: string | null
}): React.JSX.Element {
  const t = useTranslate()
  const offlineHostName = useAppStoreWithHostStatuses((s, statuses) => {
    const entry = statuses.get(runtimeEnvironmentId)
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
  const runtimeCanHostPage = useRuntimeHostStatusSelector(runtimeEnvironmentId, (entry) => {
    const capabilities = entry?.status?.capabilities
    return !capabilities || capabilities.includes(BROWSER_SCREENCAST_RUNTIME_CAPABILITY)
  })
  const ownHostClientId = readBrowserClientHostId()
  const onOtherDesktop = Boolean(
    placementHostClientId && ownHostClientId && placementHostClientId !== ownHostClientId
  )
  // Reclaim hosting on mount too; a failed lease reconnect after contact returns has no later contact edge.
  useEffect(() => {
    const state = useAppStore.getState()
    if (!onOtherDesktop && readRuntimeStatuses().get(runtimeEnvironmentId)?.status) {
      void ensureBrowserClientHostOnRuntimeContact(state, runtimeEnvironmentId)
    }
  }, [onOtherDesktop, runtimeEnvironmentId])
  const description = onOtherDesktop
    ? t(
        'browser.clientHosted.unavailableOtherDesktopDescription',
        'This page is open on another desktop.'
      )
    : offlineHostName
      ? t(
          'browser.clientHosted.unavailableHostOfflineDescription',
          '{{host}} is offline. This page will reload here once it reconnects.',
          { host: offlineHostName }
        )
      : t(
          'browser.clientHosted.unavailableDescription',
          "This page isn't available on this desktop right now."
        )
  return (
    <div className="absolute inset-0 flex items-center justify-center px-6 text-center">
      <div className="flex max-w-sm flex-col items-center gap-2">
        <Globe className="size-5 text-muted-foreground" />
        <div className="text-sm font-medium text-foreground">
          {t('browser.clientHosted.unavailableTitle', 'Client-hosted browser unavailable')}
        </div>
        <div className="text-xs leading-5 text-muted-foreground">{description}</div>
        {runtimeCanHostPage ? (
          <>
            <div className="text-xs leading-5 text-muted-foreground">{reopenOnServerCaveat(t)}</div>
            <ReopenBrowserPageOnServerButton
              browserPageId={browserPageId}
              environmentId={runtimeEnvironmentId}
              worktreeId={worktreeId}
              reopenUrl={reopenUrl}
            />
          </>
        ) : null}
      </div>
    </div>
  )
}
