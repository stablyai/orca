import React from 'react'
import { EyeOff } from 'lucide-react'
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
import type { FeatureWallSetupProgress } from '../feature-wall/feature-wall-setup-progress'
import { SetupGuideProgressRing } from '../setup-guide/SetupGuideProgressRing'
import { useSetupGuideProgress } from '../setup-guide/use-setup-guide-progress'
import { translate } from '@/i18n/i18n'

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

function isSetupGuideSidebarComplete(progress: FeatureWallSetupProgress): boolean {
  return progress.coreDoneCount >= progress.coreTotal
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
  const setupComplete = isSetupGuideSidebarComplete(setupProgress)
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
          <SetupGuideProgressRing
            done={setupProgress.coreDoneCount}
            total={setupProgress.coreTotal}
            sizeClassName="size-4"
          />
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate">
              {translate(
                'auto.components.sidebar.SetupGuideSidebarEntry.88d402b71d',
                'Onboarding checklist'
              )}
            </span>
          </span>
        </button>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={handleHideSetupGuide}>
          <EyeOff className="size-3.5" />
          {translate(
            'auto.components.sidebar.SetupGuideSidebarEntry.b0a7bfc34c',
            'Hide from sidebar'
          )}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}
