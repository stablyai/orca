import { useCallback, useState } from 'react'
import { useAppStore } from '@/store'
import type { ScheduledMessageTiming } from '../../../../shared/scheduled-message-types'
import { selectPendingScheduledCount } from '@/store/slices/scheduled-messages'

/** Lives in the menu model, not the item: the compose dialog has to outlive the
 *  dropdown that opened it. */
export function useWorkspaceScheduledMessageActions({
  menuOpen,
  worktreeId
}: {
  menuOpen: boolean
  worktreeId: string
}) {
  const [scheduleDialogOpen, setScheduleDialogOpen] = useState(false)
  // Only read while the dropdown is open: scanning the queue on every set() for
  // every closed card is waste.
  const pendingScheduledCount = useAppStore((s) =>
    menuOpen ? selectPendingScheduledCount(s, worktreeId) : 0
  )

  const handleOpenScheduleDialog = useCallback(() => {
    setScheduleDialogOpen(true)
  }, [])

  const handleScheduleMessage = useCallback(
    async (draft: { text: string; timing: ScheduledMessageTiming }) => {
      // A missing bridge or a service-less main resolves falsy, and a resolve closes the dialog.
      const created = await window.api.scheduledMessages?.add({ worktreeId, ...draft })
      if (!created) {
        throw new Error('scheduled-message-add-failed')
      }
    },
    [worktreeId]
  )

  return {
    handleOpenScheduleDialog,
    handleScheduleMessage,
    pendingScheduledCount,
    scheduleDialogOpen,
    setScheduleDialogOpen
  }
}
