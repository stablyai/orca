import React, { useState } from 'react'
import { SharedLinksList } from './shared-links-list'
import { useTranslate } from '@/i18n/use-translate'
import { shareErrorMessage, useShareClock } from './share-link-status'
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
  const { state, refresh } = action.controller
  const now = useShareClock(isVisible && action.available && state.shares.length > 0)
  const [retrying, setRetrying] = useState(false)
  if (state.status === 'unknown' || state.status === 'unsupported') {
    return null
  }
  const signedOut = state.status === 'error' && state.code === 'unauthorized'
  return (
    <>
      <SharedLinksList
        status={state.status}
        shares={state.shares}
        now={now}
        errorText={
          signedOut
            ? t(
                'auto.components.right.sidebar.CloudShare.loadSignedOut',
                'Sign in to see shared links.'
              )
            : t('auto.components.right.sidebar.CloudShare.loadFailed', 'Couldn’t load links.')
        }
        errorDetail={
          state.status === 'error' && !signedOut ? shareErrorMessage(state.code) : undefined
        }
        needsSignIn={signedOut}
        retrying={retrying}
        onShare={() => action.openShareDialog(null, detectedPorts)}
        onRetry={() => {
          setRetrying(true)
          void refresh().finally(() => setRetrying(false))
        }}
        onCopy={action.copy}
        onOpen={action.open}
        onRevoke={action.revoke}
      />
      {action.dialog}
    </>
  )
}
