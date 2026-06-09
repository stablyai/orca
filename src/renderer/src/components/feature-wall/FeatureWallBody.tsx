import type { JSX } from 'react'
import type { FeatureWallWorkflow } from '../../../../shared/feature-wall-workflows'
import type { FeatureWallOpenSourceTelemetry } from '../../../../shared/telemetry-events'
import type { AgentsStep } from '../../../../shared/agents-orchestration-steps'
import type { WorkbenchStep } from '../../../../shared/workbench-steps'
import type { ReviewStep } from '../../../../shared/review-steps'
import type { GlobalSettings } from '../../../../shared/types'
import type { InstalledAgentSkillState } from '@/hooks/useInstalledAgentSkills'
import { cn } from '@/lib/utils'
import { PreviewMedia, RelatedFeatures } from './FeatureWallPreview'
import { TasksAnimatedVisual } from './TasksAnimatedVisual'
import { WorkspacesAnimatedVisual } from './WorkspacesAnimatedVisual'
import { WorkbenchAnimatedVisual } from './WorkbenchAnimatedVisual'
import { EditorAnimatedVisual } from './EditorAnimatedVisual'
import { BrowserAnimatedVisual } from './BrowserAnimatedVisual'
import { AgentsOrchestrationVisual } from './AgentsOrchestrationVisual'
import { ReviewAnimatedVisual } from './ReviewAnimatedVisual'
import { GitHubRow, LinearRow } from '../onboarding/IntegrationsStep'
import { OrchestrationSetupCard } from '../settings/OrchestrationSetupCard'
import { BrowserUseSkillSetupCard } from './BrowserUseSkillSetupCard'
import { UsageAccountsCard } from './agents-orchestration/UsageAccountsCard'
import { AiCommitPrSettingsCard } from './AiCommitPrSettingsCard'
import { KeepAwakeCard } from './KeepAwakeCard'
import { translate } from '@/i18n/i18n'

export function FeatureWallBody(props: {
  selected: FeatureWallWorkflow
  posterUrl: string | null
  gifUrl: string | null
  showGif: boolean
  prefersReducedMotion: boolean
  source: FeatureWallOpenSourceTelemetry
  agentsActiveStep: AgentsStep | null
  workbenchActiveStep: WorkbenchStep | null
  reviewActiveStep: ReviewStep | null
  orchestrationSkill: InstalledAgentSkillState
  browserUseSkill: InstalledAgentSkillState
  onUsageAccountStateChange: () => void | Promise<void>
  settings: GlobalSettings | null
  updateSettings: (updates: Partial<GlobalSettings>) => void
}): JSX.Element {
  const {
    selected,
    posterUrl,
    gifUrl,
    showGif,
    prefersReducedMotion,
    source,
    agentsActiveStep,
    workbenchActiveStep,
    reviewActiveStep,
    orchestrationSkill,
    browserUseSkill,
    onUsageAccountStateChange
  } = props
  const isWorkspaces = selected.id === 'workspaces'
  const isTasks = selected.id === 'tasks'
  const isAgents = selected.id === 'agents-orchestration'
  const isWorkbench = selected.id === 'workbench'
  const isReview = selected.id === 'review'
  const isAgentsUsage = isAgents && agentsActiveStep?.id === 'usage'
  const isAgentsStatuses = isAgents && agentsActiveStep?.id === 'statuses'
  const isAgentsOrchestration = isAgents && agentsActiveStep?.id === 'orchestration'
  const isWorkbenchEditor = isWorkbench && workbenchActiveStep?.id === 'editor'
  const isWorkbenchBrowser = isWorkbench && workbenchActiveStep?.id === 'browser'
  const isReviewPrView = isReview && reviewActiveStep?.id === 'pr-view'
  const isReviewShip = isReview && reviewActiveStep?.id === 'ship'
  const hasAnimatedVisual = isWorkspaces || isTasks || isAgents || isWorkbench || isReview
  const isOnboardingUsage = isAgentsUsage && source === 'onboarding'
  const isOnboardingStatuses = isAgentsStatuses && source === 'onboarding'
  const isOnboardingWorkbenchBrowser = isWorkbenchBrowser && source === 'onboarding'
  const isReviewSettingStep = isReviewPrView || isReviewShip
  const isOnboardingOrchestration = isAgentsOrchestration && source === 'onboarding'
  const orchestrationVisualWidthPx = isOnboardingOrchestration ? 440 : 520
  const orchestrationVisualHeightPx = isOnboardingOrchestration ? 240 : 392
  const animatedVisualWidth = isWorkspaces
    ? 'w-[440px]'
    : isWorkbenchEditor
      ? 'w-[600px]'
      : isWorkbenchBrowser
        ? isOnboardingWorkbenchBrowser
          ? 'w-[460px]'
          : 'w-[480px]'
        : isWorkbench
          ? 'w-[560px]'
          : isReview
            ? 'w-[480px]'
            : isAgentsUsage
              ? isOnboardingUsage
                ? 'w-[360px]'
                : 'w-[400px]'
              : isAgentsStatuses
                ? 'w-[420px]'
                : isAgentsOrchestration
                  ? isOnboardingOrchestration
                    ? 'w-[440px]'
                    : 'w-[520px]'
                  : 'w-[520px]'
  const settingWidth = isTasks
    ? 'max-w-[760px]'
    : isAgentsUsage
      ? isOnboardingUsage
        ? 'max-w-[400px]'
        : 'max-w-[440px]'
      : isAgentsStatuses
        ? isOnboardingStatuses
          ? 'max-w-[360px]'
          : 'max-w-[520px]'
        : isAgentsOrchestration
          ? isOnboardingOrchestration
            ? 'max-w-[360px]'
            : 'max-w-[400px]'
          : isReviewSettingStep
            ? 'max-w-[420px]'
            : isWorkbenchBrowser
              ? isOnboardingWorkbenchBrowser
                ? 'max-w-[340px]'
                : 'max-w-[400px]'
              : 'max-w-[480px]'
  const setupTerminalHeightPx = source === 'onboarding' ? 140 : 240
  const settingContent = isTasks ? (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
      <LinearRow compact />
      <GitHubRow compact />
    </div>
  ) : isAgentsStatuses && props.settings ? (
    <KeepAwakeCard settings={props.settings} updateSettings={props.updateSettings} />
  ) : isAgentsUsage ? (
    <UsageAccountsCard onAccountStateChange={onUsageAccountStateChange} />
  ) : isAgentsOrchestration ? (
    <OrchestrationSetupCard
      compact
      terminalHeightPx={setupTerminalHeightPx}
      skill={orchestrationSkill}
    />
  ) : isWorkbenchBrowser ? (
    <BrowserUseSkillSetupCard
      compact
      terminalHeightPx={setupTerminalHeightPx}
      skill={browserUseSkill}
    />
  ) : isReviewPrView ? (
    <GitHubRow compact />
  ) : isReviewShip ? (
    <AiCommitPrSettingsCard />
  ) : null
  const shouldUseOnboardingTourZones =
    source === 'onboarding' && hasAnimatedVisual && Boolean(settingContent)
  const shouldStickSetupToBottom = shouldUseOnboardingTourZones
  // Why: several visuals expand/collapse internally; setup controls should sit
  // after a stable stage so they do not jump with the animation loop.
  const visualStageHeight = isTasks
    ? 'h-[288px]'
    : isWorkbenchEditor
      ? 'h-[390px]'
      : isWorkbenchBrowser
        ? 'h-[270px]'
        : isWorkbench
          ? 'h-[340px]'
          : isReview
            ? 'h-[416px]'
            : isAgentsOrchestration
              ? isOnboardingOrchestration
                ? 'h-[240px]'
                : 'h-[392px]'
              : isAgentsStatuses
                ? isOnboardingStatuses
                  ? 'h-[200px]'
                  : 'h-[250px]'
                : isAgentsUsage
                  ? isOnboardingUsage
                    ? 'h-[320px]'
                    : 'h-[392px]'
                  : 'h-[330px]'
  const animatedVisual = isWorkspaces ? (
    <WorkspacesAnimatedVisual reducedMotion={prefersReducedMotion} />
  ) : isTasks ? (
    <TasksAnimatedVisual reducedMotion={prefersReducedMotion} />
  ) : isReview && reviewActiveStep ? (
    <ReviewAnimatedVisual reducedMotion={prefersReducedMotion} activeStepId={reviewActiveStep.id} />
  ) : isWorkbench ? (
    workbenchActiveStep?.id === 'editor' ? (
      <EditorAnimatedVisual reducedMotion={prefersReducedMotion} />
    ) : isWorkbenchBrowser ? (
      <BrowserAnimatedVisual reducedMotion={prefersReducedMotion} />
    ) : (
      <WorkbenchAnimatedVisual reducedMotion={prefersReducedMotion} />
    )
  ) : isAgentsOrchestration && agentsActiveStep ? (
    <AgentsOrchestrationVisual
      reducedMotion={prefersReducedMotion}
      activeStepId={agentsActiveStep.id}
      widthPx={orchestrationVisualWidthPx}
      heightPx={orchestrationVisualHeightPx}
    />
  ) : agentsActiveStep ? (
    <AgentsOrchestrationVisual
      reducedMotion={prefersReducedMotion}
      activeStepId={agentsActiveStep.id}
      widthPx={isAgentsUsage ? (isOnboardingUsage ? 360 : 400) : isAgentsStatuses ? 420 : undefined}
      heightPx={
        isAgentsUsage
          ? isOnboardingUsage
            ? 320
            : undefined
          : isAgentsStatuses
            ? isOnboardingStatuses
              ? 200
              : 250
            : undefined
      }
    />
  ) : null
  const animatedVisualNode = (
    <div className={cn('flex w-full items-start justify-center', visualStageHeight)}>
      <div
        className={cn(
          'max-w-full',
          animatedVisualWidth,
          isAgentsOrchestration && !isOnboardingOrchestration ? 'translate-x-6' : null
        )}
      >
        {animatedVisual}
      </div>
    </div>
  )
  const previewVisualNode = shouldUseOnboardingTourZones ? (
    <TourZone className="items-center">{animatedVisualNode}</TourZone>
  ) : (
    animatedVisualNode
  )

  return (
    <div className="flex min-h-full flex-col gap-4 px-8 pb-0 pt-1">
      <div
        className={cn(
          'grid grid-cols-1 items-start gap-7',
          hasAnimatedVisual ? 'justify-items-center' : 'lg:grid-cols-[minmax(0,1fr)_320px]'
        )}
      >
        {!hasAnimatedVisual ? (
          <PreviewMedia
            key={selected.id}
            posterUrl={posterUrl}
            gifUrl={gifUrl}
            showGif={showGif}
            workflowTitle={selected.title}
          />
        ) : null}

        {hasAnimatedVisual ? (
          previewVisualNode
        ) : (
          <aside className="flex flex-col gap-5">
            {selected.relatedTileIds.length > 0 ? (
              <RelatedFeatures workflow={selected} source={source} />
            ) : null}
          </aside>
        )}
      </div>
      {settingContent && shouldStickSetupToBottom ? (
        <div className="sticky bottom-0 z-10 -mx-8 mt-auto border-t border-border bg-card/95 px-8 py-3 backdrop-blur supports-[backdrop-filter]:bg-card/85">
          <TourZone
            className={cn(
              'scrollbar-sleek mx-auto max-h-[220px] w-full gap-2 overflow-y-auto',
              settingWidth
            )}
          >
            <>
              <div className="text-center text-[11px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
                {translate("auto.components.feature.wall.FeatureWallBody.25ec5356d6", "Setup")}</div>
              {settingContent}
            </>
          </TourZone>
        </div>
      ) : settingContent ? (
        <TourZone className={cn('mx-auto w-full', settingWidth)}>{settingContent}</TourZone>
      ) : null}
    </div>
  )
}

function TourZone(props: { className?: string; children: JSX.Element | null }): JSX.Element {
  const { className, children } = props
  return <div className={cn('flex min-w-0 flex-col', className)}>{children}</div>
}
