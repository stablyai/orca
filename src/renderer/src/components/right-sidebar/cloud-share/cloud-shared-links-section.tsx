import React from 'react'
import { SharedLinksList } from './shared-links-list'
import { useTranslate } from '@/i18n/use-translate'
import { useShareClock } from './share-link-status'
import type { SharePortAction } from './use-share-port-action'

/** Shared links + the Share dialog for an Orca Cloud workspace; nothing elsewhere. */
export function CloudSharedLinksSection({
  action,
  isVisible,
  detectedPorts
}: {
  action: SharePortAction
  isVisible: boolean
  /** Listening ports, offered as one-click choices in "Share a port". */
  detectedPorts: readonly number[]
}): React.JSX.Element | null {
  const t = useTranslate()
  const { state } = action.controller
  const now = useShareClock(isVisible && action.available && state.shares.length > 0)
  if (state.status !== 'ready' && state.status !== 'error') {
    return null
  }
  return (
    <>
      <SharedLinksList
        status={state.status}
        shares={state.shares}
        now={now}
        errorText={
          state.status === 'error'
            ? t('auto.components.right.sidebar.CloudShare.loadFailed', 'Couldn’t load links.')
            : undefined
        }
        onShare={() => action.openShareDialog(null, detectedPorts)}
        onRetry={() => void action.controller.refresh()}
        onCopy={action.copy}
        onOpen={action.open}
        onRevoke={action.revoke}
      />
      {action.dialog}
    </>
  )
}
