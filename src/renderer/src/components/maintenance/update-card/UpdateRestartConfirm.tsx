import { useState } from 'react'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../../shared/execution-host'
import { structuredAgentSessionPaneKey } from '../../../../../shared/agent-session/view/structured-agent-session-projection'
import { translate } from '@/i18n/i18n'
import { structuredAgentSessionOwnerForTab } from '@/runtime/structured-agent-session-owner'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { getStructuredAgentSessionTabs } from '../../native-chat/structured-agent-session-tabs'
import { Button } from '../../ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '../../ui/dialog'

/** Terminals survive an update restart in the daemon; this machine's chat turns are the work it stops. */
export function countLocalChatsMidReply(state: AppState): number {
  let count = 0
  for (const tab of getStructuredAgentSessionTabs(state.unifiedTabsByWorktree)) {
    const paneKey = structuredAgentSessionPaneKey(tab.id, tab.entityId)
    if (
      state.agentStatusByPaneKey[paneKey]?.state === 'working' &&
      structuredAgentSessionOwnerForTab(state, tab) === LOCAL_EXECUTION_HOST_ID
    ) {
      count += 1
    }
  }
  return count
}

export function useUpdateRestartRequest(onInstallError?: (message: string) => void): {
  requestRestart: () => void
  confirmDialog: React.JSX.Element
} {
  const [chatsMidReply, setChatsMidReply] = useState(0)
  const restart = (): void => {
    setChatsMidReply(0)
    void window.api.updater.quitAndInstall().catch((error) => {
      const message = String((error as Error)?.message ?? error)
      if (onInstallError) {
        onInstallError(message)
      } else {
        console.error('[updates] restart to update failed:', error)
      }
    })
  }
  const requestRestart = (): void => {
    const count = countLocalChatsMidReply(useAppStore.getState())
    if (count === 0) {
      restart()
      return
    }
    setChatsMidReply(count)
  }
  const confirmDialog = (
    <Dialog open={chatsMidReply > 0} onOpenChange={(open) => !open && setChatsMidReply(0)}>
      <DialogContent onOpenAutoFocus={(event) => event.preventDefault()}>
        <DialogHeader>
          <DialogTitle>
            {translate('updates.restartConfirm.title', 'Restart to update now?')}
          </DialogTitle>
          <DialogDescription>
            {translate(
              'updates.restartConfirm.chatsMidReply',
              '{{count}} chats are still replying. Restarting stops them, and you can resume them when Orca reopens. Terminals keep running.',
              {
                count: chatsMidReply,
                defaultValue_one:
                  '{{count}} chat is still replying. Restarting stops it, and you can resume it when Orca reopens. Terminals keep running.'
              }
            )}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setChatsMidReply(0)} autoFocus>
            {translate('updates.restartConfirm.cancel', 'Not Now')}
          </Button>
          <Button onClick={restart}>
            {translate('auto.components.UpdateCard.68b235d264', 'Restart to Update')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
  return { requestRestart, confirmDialog }
}
