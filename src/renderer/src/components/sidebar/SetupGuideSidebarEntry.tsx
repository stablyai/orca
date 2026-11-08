import React from 'react'
import { EyeOff } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useAppStore } from '@/store'
import { Button } from '@/components/ui/button'
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
import { useTranslate } from '@/i18n/use-translate'

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
  const t = useTranslate()
  const openModal = useAppStore((s) => s.openModal)
  const activeModal = useAppStore((s) => s.activeModal)
  const persistedUIReady = useAppStore((s) => s.persistedUIReady)
  const setupGuideSidebarDismissed = useAppStore((s) => s.setupGuideSidebarDismissed)
  const setSetupGuideSidebarDismissed = useAppStore((s) => s.setSetupGuideSidebarDismissed)
  // Warm progress before click so lazy modal mounting cannot change the displayed count.
  const setupProgress = useSetupGuideProgress(true, false, false)
  const setupComplete = isSetupGuideSidebarComplete(setupProgress)
  const setupActive = activeModal === 'setup-guide'
  const showSetupGuideEntry = shouldShowSetupGuideEntry({
    ready: getSetupGuideSidebarEntryReady(persistedUIReady, setupProgress.ready),
    setupComplete,
    dismissed: setupGuideSidebarDismissed
  })
  const lastVisibleProgressRef = React.useRef<FeatureWallSetupProgress | null>(null)
  const rowRef = React.useRef<HTMLDivElement>(null)
  if (showSetupGuideEntry) {
    lastVisibleProgressRef.current = setupProgress
  }
  // Keep an already-visible checklist row stable through host/workspace probe refreshes.
  const renderedProgress = showSetupGuideEntry
    ? setupProgress
    : !setupProgress.ready && !setupGuideSidebarDismissed
      ? lastVisibleProgressRef.current
      : null
  const handleHideSetupGuide = React.useCallback(() => {
    const row = rowRef.current
    if (row?.contains(document.activeElement) && row.parentElement) {
      const controls = Array.from(
        row.parentElement.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')
      ).filter((button) => button.tabIndex >= 0 && button.getClientRects().length > 0)
      const lastRowControl = controls.findLastIndex((button) => row.contains(button))
      const nextControl =
        controls[lastRowControl + 1] ?? controls.findLast((button) => !row.contains(button))
      nextControl?.focus({ preventScroll: true })
    }
    setSetupGuideSidebarDismissed(true)
  }, [setSetupGuideSidebarDismissed])

  if (!renderedProgress) {
    return null
  }
  const firstUnfinishedSetupStepId: FeatureWallSetupStepId =
    getFirstIncompleteFeatureWallSetupStepId(renderedProgress.stepDone)

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          ref={rowRef}
          className={cn(
            'flex w-full items-center rounded-md text-[13px] font-medium tracking-tight transition-colors',
            setupActive
              ? 'bg-worktree-sidebar-accent text-worktree-sidebar-accent-foreground'
              : 'text-worktree-sidebar-foreground/60 hover:bg-worktree-sidebar-foreground/8'
          )}
        >
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
            className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left"
          >
            <SetupGuideProgressRing
              done={renderedProgress.coreDoneCount}
              total={renderedProgress.coreTotal}
              sizeClassName="size-4"
            />
            <span className="min-w-0 flex-1 truncate">
              {t(
                'auto.components.sidebar.SetupGuideSidebarEntry.88d402b71d',
                'Onboarding checklist'
              )}
            </span>
          </button>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="mr-1"
            onClick={handleHideSetupGuide}
            aria-label={t(
              'auto.components.sidebar.SetupGuideSidebarEntry.b0a7bfc34c',
              'Hide from sidebar'
            )}
          >
            {t('auto.components.sidebar.WorktreeVisibilitySourceList.hide', 'Hide')}
          </Button>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={handleHideSetupGuide}>
          <EyeOff className="size-3.5" />
          {t('auto.components.sidebar.SetupGuideSidebarEntry.b0a7bfc34c', 'Hide from sidebar')}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}
