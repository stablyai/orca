import React from 'react'
import { useAppStore } from '@/store'
import { SidebarFeedbackDialog } from '../sidebar/SidebarFeedbackDialog'

/**
 * App-root host for the feedback dialog, opened from the sidebar help menu or
 * Help > Send Feedback.
 *
 * Why: it stays mounted while closed so the typed report and its attachments
 * survive a reflex Escape, and so an in-flight submit still lands its toast.
 */
export function AppFeedbackDialog(): React.JSX.Element {
  const open = useAppStore((s) => s.feedbackDialogOpen)
  const setOpen = useAppStore((s) => s.setFeedbackDialogOpen)

  return <SidebarFeedbackDialog open={open} onOpenChange={setOpen} />
}
