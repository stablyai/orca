import { useEffect, useState } from 'react'
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
  /** Turns local search on; the stage then follows the index. */
  enable: () => Promise<void>
}

/**
 * The tip's view of local session search, read from the setting and the index itself so a
 * build started from Settings shows the same progress. The feature-tips modal stays mounted
 * after it closes, so a build the user left mid-index is still watched and toasts once ready.
 */
export function useSessionSearchTipSetup({
  dialogOpen
}: {
  dialogOpen: boolean
}): SessionSearchTipSetup {
  const showAiVaultSearch = useAppStore((s) => s.showAiVaultSearch)
  const searchEnabled = useAppStore((s) => resolveAiVaultSearchSettings(s.settings).enabled)
  const [wasOpen, setWasOpen] = useState(dialogOpen)
  const [toastWhenReady, setToastWhenReady] = useState(false)
  const [readyToastStatus, setReadyToastStatus] = useState<AiVaultSearchStatus | null>(null)
  const read = useSessionSearchStatus({
    executionHostId: LOCAL_EXECUTION_HOST_ID,
    active: searchEnabled && (dialogOpen || toastWhenReady)
  })
  let stage: SessionSearchTipStage = 'offer'
  if (searchEnabled) {
    stage = isSessionSearchIndexReady(read.status) ? 'ready' : 'indexing'
  }

  // Why: closing this tip mid-index is the only thing that asks for a later toast.
  if (wasOpen !== dialogOpen) {
    setWasOpen(dialogOpen)
    if (!dialogOpen && stage === 'indexing') {
      setToastWhenReady(true)
    }
  }
  if (toastWhenReady && !searchEnabled) {
    setToastWhenReady(false)
  }
  if (toastWhenReady && stage === 'ready' && read.status) {
    setToastWhenReady(false)
    setReadyToastStatus(read.status)
  }

  useEffect(() => {
    if (!readyToastStatus) {
      return
    }
    toast.success(translate('featureTips.sessionSearch.readyToast', 'Session search is ready'), {
      description: sessionSearchStatusMessage(readyToastStatus),
      action: {
        label: translate('featureTips.sessionSearch.readyToastOpen', 'Open'),
        onClick: showAiVaultSearch
      }
    })
  }, [readyToastStatus, showAiVaultSearch])

  return {
    stage,
    status: read.status,
    enable: async () => {
      const store = useAppStore.getState()
      try {
        await store.updateSettingsOrThrow({
          aiVaultSearch: { ...resolveAiVaultSearchSettings(store.settings), enabled: true }
        })
      } catch {
        toast.error(
          translate(
            'featureTips.sessionSearch.enableFailed',
            'Could not turn on session search. Try again.'
          )
        )
      }
    }
  }
}
