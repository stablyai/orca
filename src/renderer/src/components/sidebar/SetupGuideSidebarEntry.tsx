import React from 'react'
import { ListChecks, X } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { useAppStore } from '@/store'
import {
  FEATURE_WALL_SETUP_PARALLEL_WORK_STEP_IDS,
  getFirstIncompleteFeatureWallSetupStepId,
  type FeatureWallSetupStepId
} from '../../../../shared/feature-wall-setup-steps'
import { useSetupGuideProgress } from '../setup-guide/use-setup-guide-progress'

export function shouldShowSetupGuideEntry(setupComplete: boolean, dismissed: boolean): boolean {
  return !setupComplete && !dismissed
}

export function SetupGuideSidebarEntry(): React.JSX.Element | null {
  const openModal = useAppStore((s) => s.openModal)
  const activeModal = useAppStore((s) => s.activeModal)
  const setupGuideSidebarDismissed = useAppStore((s) => s.setupGuideSidebarDismissed)
  const setSetupGuideSidebarDismissed = useAppStore((s) => s.setSetupGuideSidebarDismissed)
  // Why: the sidebar count must be warmed before click so it matches the modal
  // count instead of changing while the lazy modal is mounting.
  const setupProgress = useSetupGuideProgress(true, false, false)
  const setupComplete = setupProgress.coreDoneCount >= setupProgress.coreTotal
  const setupActive = activeModal === 'setup-guide'
  const firstUnfinishedSetupStepId = React.useMemo<FeatureWallSetupStepId>(
    () => getFirstIncompleteFeatureWallSetupStepId(setupProgress.stepDone),
    [setupProgress.stepDone]
  )
  const hasIncompleteParallelWork = FEATURE_WALL_SETUP_PARALLEL_WORK_STEP_IDS.some(
    (id) => !setupProgress.stepDone[id]
  )
  const showSetupGuideEntry = shouldShowSetupGuideEntry(setupComplete, setupGuideSidebarDismissed)
  const handleHideSetupGuide = React.useCallback(() => {
    setSetupGuideSidebarDismissed(true)
    toast('see it anytime from the help menu')
  }, [setSetupGuideSidebarDismissed])

  if (!showSetupGuideEntry) {
    return null
  }

  return (
    <div
      data-contextual-tour-target="setup-guide-entry"
      className={cn(
        'group/setup-guide relative rounded-md border border-sidebar-border transition-colors',
        setupActive
          ? 'bg-sidebar-accent text-sidebar-accent-foreground ring-1 ring-sidebar-ring'
          : 'bg-sidebar-accent/60 text-sidebar-foreground hover:bg-sidebar-accent'
      )}
    >
      <button
        type="button"
        onClick={() => openModal('setup-guide', { setupStepId: firstUnfinishedSetupStepId })}
        aria-current={setupActive ? 'page' : undefined}
        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] font-medium tracking-tight"
      >
        <ListChecks
          className={cn(
            'size-4 shrink-0',
            setupActive ? 'text-sidebar-accent-foreground' : 'text-sidebar-foreground/70'
          )}
          strokeWidth={setupActive ? 2.25 : 1.75}
        />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate">Getting started with Orca</span>
          {hasIncompleteParallelWork ? (
            <span className="truncate text-[11px] font-normal leading-3 text-muted-foreground">
              See what Orca can do
            </span>
          ) : null}
        </span>
        <span className="font-mono text-[11px] text-muted-foreground">
          {setupProgress.coreDoneCount}/{setupProgress.coreTotal}
        </span>
      </button>
      <button
        type="button"
        aria-label="Hide Getting started with Orca"
        onClick={handleHideSetupGuide}
        className="pointer-events-none absolute -right-1 -top-1 flex size-4 items-center justify-center rounded-full border border-sidebar-border bg-sidebar text-sidebar-foreground/60 opacity-0 shadow-xs transition-colors transition-opacity group-hover/setup-guide:pointer-events-auto group-hover/setup-guide:opacity-100 group-focus-within/setup-guide:pointer-events-auto group-focus-within/setup-guide:opacity-100 hover:bg-sidebar-accent hover:text-sidebar-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-sidebar-ring"
      >
        <X className="size-2.5" aria-hidden />
      </button>
    </div>
  )
}
