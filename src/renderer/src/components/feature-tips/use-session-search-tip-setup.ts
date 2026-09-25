import { useCallback, useState } from 'react'
import { toast } from 'sonner'
import { resolveAiVaultSearchSettings } from '../../../../shared/ai-vault-search-settings'
import type { AiVaultSearchStatus } from '../../../../shared/ai-vault-search-types'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'
import {
  isSessionSearchIndexReady,
  sessionSearchStatusMessage
} from '@/components/settings/session-history-status-copy'
import { useSessionSearchStatus } from '@/components/settings/use-session-search-status'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'

export type SessionSearchTipStage = 'offer' | 'indexing' | 'ready'

export type SessionSearchTipSetup = {
  stage: SessionSearchTipStage
  status: AiVaultSearchStatus | null
  /** The status read failed; indexing still runs, only the count is unknown. */
  statusUnavailable: boolean
  /** Turns search on; resolves false when the setting could not be saved. */
  enable: () => Promise<boolean>
  /** The dialog closed; an unfinished index keeps being watched so a toast can say when it is done. */
  dialogClosed: () => void
  reset: () => void
}

/**
 * The tip's view of local session search, read from the setting and the index itself so a
 * build started from Settings shows the same progress. The feature-tips modal stays mounted
 * after it closes, so a build the user left running keeps being watched and toasts once ready.
 */
export function useSessionSearchTipSetup({
  dialogOpen
}: {
  dialogOpen: boolean
}): SessionSearchTipSetup {
  const showAiVaultSearch = useAppStore((s) => s.showAiVaultSearch)
  const searchEnabled = useAppStore((s) => resolveAiVaultSearchSettings(s.settings).enabled)
  const [watchingInBackground, setWatchingInBackground] = useState(false)

  // Why: toasting from the poll answer (not an effect) fires exactly once, when readiness arrives.
  const handleStatus = useCallback(
    (next: AiVaultSearchStatus) => {
      if (!watchingInBackground || !isSessionSearchIndexReady(next)) {
        return
      }
      setWatchingInBackground(false)
      toast.success(translate('featureTips.sessionSearch.readyToast', 'Session search is ready'), {
        description: sessionSearchStatusMessage(next),
        action: {
          label: translate('featureTips.sessionSearch.readyToastOpen', 'Open'),
          onClick: showAiVaultSearch
        }
      })
    },
    [showAiVaultSearch, watchingInBackground]
  )

  const read = useSessionSearchStatus({
    executionHostId: LOCAL_EXECUTION_HOST_ID,
    active: searchEnabled && (dialogOpen || watchingInBackground),
    onStatus: handleStatus
  })
  let stage: SessionSearchTipStage = 'offer'
  if (searchEnabled) {
    stage = isSessionSearchIndexReady(read.status) ? 'ready' : 'indexing'
  }

  return {
    stage,
    status: read.status,
    statusUnavailable: read.failed || read.hostTooOld,
    enable: async () => {
      const store = useAppStore.getState()
      try {
        await store.updateSettingsOrThrow({
          aiVaultSearch: { ...resolveAiVaultSearchSettings(store.settings), enabled: true }
        })
        return true
      } catch {
        toast.error(
          translate(
            'featureTips.sessionSearch.enableFailed',
            'Could not turn on session search. Try again.'
          )
        )
        return false
      }
    },
    dialogClosed: () => setWatchingInBackground(stage === 'indexing'),
    reset: () => setWatchingInBackground(false)
  }
}
