import { useEffect, useId, useState } from 'react'
import { Globe } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'
import { useRuntimeHostStatusSelector } from '@/store/slices/runtime-status/views/use-runtime-status-view'
import { readRuntimeStatuses } from '@/store/slices/runtime-status/views/runtime-status-owner'
import { useAppStore } from '@/store'
import { readBrowserClientHostId } from '@/runtime/browser/client-hosting/browser-client-host-identity'
import { ensureBrowserClientHostOnRuntimeContact } from '@/runtime/browser/client-hosting/restored-client-hosted-browser-host-attach'
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
  const [detailsOpen, setDetailsOpen] = useState(false)
  const detailsId = useId()
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
  return (
    <div className="absolute inset-0 scrollbar-sleek flex overflow-y-auto p-4 text-center">
      {/* m-auto (not justify-center) keeps a tall block scrollable from the top in short panes.
          Relative so the Details box hangs below without re-centering the block under the pointer. */}
      <div className="relative m-auto flex max-w-sm flex-col items-center">
        <Globe className="size-5 text-muted-foreground" />
        <div className="mt-3 text-balance text-[15px] font-semibold leading-5 text-foreground">
          {runtimeCanHostPage
            ? t('browser.clientHosted.runsOnServerTitle', 'This tab runs on your server')
            : t('browser.clientHosted.noBrowserTitle', 'Can’t open this tab here')}
        </div>
        {!runtimeCanHostPage ? (
          <div className="mt-1 text-[13px] leading-5 text-muted-foreground">
            {t('browser.clientHosted.noBrowserBody', 'This server has no browser.')}
          </div>
        ) : null}
        {runtimeCanHostPage ? (
          <>
            <div className="mt-1 text-[13px] leading-5 text-muted-foreground">
              {t('browser.clientHosted.runsOnServerBody', 'Open it there to keep going.')}
            </div>
            <ReopenBrowserPageOnServerButton
              className="mt-4"
              variant="default"
              caveatTooltip={false}
              browserPageId={browserPageId}
              environmentId={runtimeEnvironmentId}
              worktreeId={worktreeId}
              reopenUrl={reopenUrl}
            />
            <button
              type="button"
              className="mt-2 min-h-6 cursor-pointer rounded-sm px-2 text-xs leading-5 text-muted-foreground hover:text-foreground aria-expanded:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-expanded={detailsOpen}
              aria-controls={detailsId}
              onClick={() => setDetailsOpen((open) => !open)}
            >
              {t('browser.clientHosted.details', 'Details')}
            </button>
            <div
              id={detailsId}
              hidden={!detailsOpen}
              className="absolute inset-x-0 top-full mt-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-balance text-xs leading-5 text-muted-foreground"
            >
              {reopenOnServerCaveat(t)}
            </div>
          </>
        ) : null}
      </div>
    </div>
  )
}
