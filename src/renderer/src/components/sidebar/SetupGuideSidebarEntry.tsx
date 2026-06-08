import React from 'react'
import { EyeOff } from 'lucide-react'
import logo from '../../../../../resources/logo.svg'
import { cn } from '@/lib/utils'
import { useAppStore } from '@/store'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
import {
  getFirstIncompleteFeatureWallSetupStepId,
  type FeatureWallSetupStepId
} from '../../../../shared/feature-wall-setup-steps'
import { SetupGuideProgressRing } from '../setup-guide/SetupGuideProgressRing'
import { useSetupGuideProgress } from '../setup-guide/use-setup-guide-progress'

export type SetupGuideEntryVisibilityInput = {
  ready: boolean
  setupComplete: boolean
  dismissed: boolean
}

export function shouldShowSetupGuideEntry(input: SetupGuideEntryVisibilityInput): boolean {
  return input.ready && !input.setupComplete && !input.dismissed
}

export function getSetupGuideSidebarEntryReady(
  persistedUIReady: boolean,
  setupProgressReady: boolean
): boolean {
  return persistedUIReady && setupProgressReady
}

export function SetupGuideSidebarEntry(): React.JSX.Element | null {
  const openModal = useAppStore((s) => s.openModal)
  const activeModal = useAppStore((s) => s.activeModal)
  const persistedUIReady = useAppStore((s) => s.persistedUIReady)
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
  const showSetupGuideEntry = shouldShowSetupGuideEntry({
    ready: getSetupGuideSidebarEntryReady(persistedUIReady, setupProgress.ready),
    setupComplete,
    dismissed: setupGuideSidebarDismissed
  })
  const handleHideSetupGuide = React.useCallback(() => {
    setSetupGuideSidebarDismissed(true)
  }, [setSetupGuideSidebarDismissed])

  if (!showSetupGuideEntry) {
    return null
  }

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <button
          type="button"
          data-contextual-tour-target="setup-guide-entry"
          onClick={() =>
            openModal('setup-guide', {
              setupStepId: firstUnfinishedSetupStepId,
              telemetrySource: 'sidebar'
            })
          }
          aria-current={setupActive ? 'page' : undefined}
          className={cn(
            'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] font-medium tracking-tight transition-colors',
            setupActive
              ? 'bg-worktree-sidebar-accent text-worktree-sidebar-accent-foreground'
              : 'text-worktree-sidebar-foreground/60 hover:bg-worktree-sidebar-foreground/8'
          )}
        >
          <img
            src={logo}
            alt=""
            aria-hidden="true"
            className={cn(
              'size-4 shrink-0 object-contain invert dark:invert-0',
              setupActive ? 'opacity-75' : 'opacity-30'
            )}
          />
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate">Onboarding checklist</span>
          </span>
          <SetupGuideProgressRing
            done={setupProgress.coreDoneCount}
            total={setupProgress.coreTotal}
          />
        </button>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={handleHideSetupGuide}>
          <EyeOff className="size-3.5" />
          Hide from sidebar
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}
