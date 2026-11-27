import React from 'react'
import { EyeOff } from 'lucide-react'
import { cn } from '@/lib/class-names'
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
} from '../../../../shared/feature-education/explore/feature-wall-setup-steps'
import type { FeatureWallSetupProgress } from '../feature-wall/setup/feature-wall-setup-progress'
import { SetupGuideProgressRing } from './SetupGuideProgressRing'
import { useTranslate } from '@/i18n/use-translate'

export function SetupGuideSidebarEntryBody({
  renderedProgress,
  setupActive,
  rowRef,
  onOpenSetupGuide,
  onHideSetupGuide
}: {
  renderedProgress: FeatureWallSetupProgress
  setupActive: boolean
  rowRef: React.RefObject<HTMLDivElement | null>
  onOpenSetupGuide: (stepId: FeatureWallSetupStepId) => void
  onHideSetupGuide: () => void
}): React.JSX.Element {
  const t = useTranslate()
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
            onClick={() => onOpenSetupGuide(firstUnfinishedSetupStepId)}
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
            onClick={onHideSetupGuide}
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
        <ContextMenuItem onSelect={onHideSetupGuide}>
          <EyeOff className="size-3.5" />
          {t('auto.components.sidebar.SetupGuideSidebarEntry.b0a7bfc34c', 'Hide from sidebar')}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}
