import React, { useState } from 'react'
import { toast } from 'sonner'
import { lazyWithRetry } from '@/app-shell/startup/lazy-with-retry'
import { useMountedRef } from '@/hooks/useMountedRef'
import { useTranslate } from '@/i18n/use-translate'
import type * as SidebarFeedbackDialogModule from '../sidebar-feedback/SidebarFeedbackDialog'

// Keep feedback off the boot graph; menu warming and selection share the same lazy module entry.
const loadSidebarFeedbackDialog = (): Promise<typeof SidebarFeedbackDialogModule> =>
  import('../sidebar-feedback/SidebarFeedbackDialog')

const SidebarFeedbackDialog = lazyWithRetry(
  () => loadSidebarFeedbackDialog().then((module) => ({ default: module.SidebarFeedbackDialog })),
  { reloadKey: 'sidebar-feedback-dialog' }
)

const LazyHelpMenuItems = lazyWithRetry(
  () => import('./HelpMenuItems').then((module) => ({ default: module.HelpMenuItems })),
  { reloadKey: 'help-menu-items' }
)

const LazyMilestonesMenuItem = lazyWithRetry(
  () => import('./HelpMenuItems').then((module) => ({ default: module.MilestonesMenuItemContent })),
  { reloadKey: 'milestones-menu-item' }
)

export type SetupMilestones = { done: number; total: number }

/** Help's Milestones row (opens the setup guide). `badge` shows done/total as text (the rail's account menu). */
export function MilestonesMenuItem({
  milestones,
  progress = 'ring'
}: {
  milestones: SetupMilestones
  progress?: 'ring' | 'badge'
}): React.JSX.Element {
  return (
    <React.Suspense fallback={null}>
      <LazyMilestonesMenuItem milestones={milestones} progress={progress} />
    </React.Suspense>
  )
}

/** Help's menu rows and feedback dialog, so the same Help can open from its own button or as a More submenu. */
export type HelpMenuController = {
  items: React.ReactNode
  dialog: React.ReactNode
  handleMenuOpenChange: (open: boolean) => void
}

/** `grouped`: links in one group, then updates + restart (the rail's account menu, which has its own groups above). */
export type HelpMenuDividers = 'default' | 'grouped'

export function useHelpMenuController(
  milestones: SetupMilestones | null,
  dividers: HelpMenuDividers = 'default'
): HelpMenuController {
  const [feedbackOpen, setFeedbackOpen] = useState(false)
  // Retain the mounted dialog through its closing animation.
  const [feedbackDialogMounted, setFeedbackDialogMounted] = useState(false)
  const t = useTranslate()
  const [isRestartingOrca, setIsRestartingOrca] = useState(false)
  const lastShowOnboardingAtRef = React.useRef(0)
  const mountedRef = useMountedRef()

  // Owned here, not by the menu items: selecting Restart closes the menu and unmounts the items,
  // so a failure handled there would never clear isRestartingOrca or show the error.
  const handleRestartOrca = (): void => {
    if (isRestartingOrca) {
      return
    }
    setIsRestartingOrca(true)
    toast.info(t('auto.components.sidebar.SidebarSettingsHelpMenu.5161eef55d', 'Restarting Orca…'))
    void window.api.app.restart().catch((error) => {
      if (mountedRef.current) {
        setIsRestartingOrca(false)
        toast.error(
          t('auto.components.sidebar.SidebarSettingsHelpMenu.4e8f5710d3', "Couldn't restart Orca."),
          { description: error instanceof Error ? error.message : undefined }
        )
      }
    })
  }

  const handleMenuOpenChange = (open: boolean): void => {
    if (open) {
      // Warm while users read the menu so feedback is loaded before selection.
      void loadSidebarFeedbackDialog().catch(() => {})
    }
  }

  const handleOpenFeedback = (): void => {
    setFeedbackDialogMounted(true)
    setFeedbackOpen(true)
  }

  return {
    items: (
      <React.Suspense fallback={null}>
        <LazyHelpMenuItems
          milestones={milestones}
          dividers={dividers}
          isRestartingOrca={isRestartingOrca}
          onRestartOrca={handleRestartOrca}
          onOpenFeedback={handleOpenFeedback}
          lastShowOnboardingAtRef={lastShowOnboardingAtRef}
        />
      </React.Suspense>
    ),
    dialog: (
      <>
        {feedbackDialogMounted ? (
          <React.Suspense fallback={null}>
            <SidebarFeedbackDialog open={feedbackOpen} onOpenChange={setFeedbackOpen} />
          </React.Suspense>
        ) : null}
      </>
    ),
    handleMenuOpenChange
  }
}
