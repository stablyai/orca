import type { JSX } from 'react'
import type { FeatureWallWorkflow } from '../../../../shared/feature-wall-workflows'
import type { FeatureWallOpenSourceTelemetry } from '../../../../shared/telemetry-events'
import type { AgentsStep } from '../../../../shared/agents-orchestration-steps'
import type { WorkbenchStep } from '../../../../shared/workbench-steps'
import type { ReviewStep } from '../../../../shared/review-steps'
import type { GlobalSettings } from '../../../../shared/types'
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
  onOrchestrationSkillInstalledChange: (installed: boolean) => void
  onBrowserUseSkillInstalledChange: (installed: boolean) => void
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
    onOrchestrationSkillInstalledChange,
    onBrowserUseSkillInstalledChange,
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
  const isOnboardingWorkbenchBrowser = isWorkbenchBrowser && source === 'onboarding'
  const isReviewSettingBesideVisual = isReviewPrView || isReviewShip
  const isOnboardingOrchestrationBesideVisual = isAgentsOrchestration && source === 'onboarding'
  const orchestrationVisualWidthPx = isOnboardingOrchestrationBesideVisual ? 440 : 520
  const orchestrationVisualHeightPx = 392
  const isCompactBesideVisual =
    source === 'onboarding' &&
    (isAgentsUsage || isReviewSettingBesideVisual || isAgentsOrchestration)
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
                ? 'w-[340px]'
                : 'w-[400px]'
              : isAgentsStatuses
                ? 'w-[420px]'
                : isAgentsOrchestration
                  ? isOnboardingOrchestrationBesideVisual
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
        ? 'max-w-[520px]'
        : isAgentsOrchestration
          ? isOnboardingOrchestrationBesideVisual
            ? 'max-w-[360px]'
            : 'max-w-[400px]'
          : isReviewSettingBesideVisual
            ? isCompactBesideVisual
              ? 'max-w-[320px]'
              : 'max-w-[420px]'
            : isWorkbenchBrowser
              ? isOnboardingWorkbenchBrowser
                ? 'max-w-[340px]'
                : 'max-w-[400px]'
              : 'max-w-[480px]'
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
      terminalHeightPx={240}
      onInstalledChange={onOrchestrationSkillInstalledChange}
    />
  ) : isWorkbenchBrowser ? (
    <BrowserUseSkillSetupCard
      compact
      terminalHeightPx={240}
      onInstalledChange={onBrowserUseSkillInstalledChange}
    />
  ) : isReviewPrView ? (
    <GitHubRow compact />
  ) : isReviewShip ? (
    <AiCommitPrSettingsCard />
  ) : null
  const settingBesideVisual =
    isAgentsUsage || isAgentsOrchestration || isWorkbenchBrowser || isReviewSettingBesideVisual
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
              ? 'h-[392px]'
              : isAgentsStatuses
                ? 'h-[250px]'
                : isAgentsUsage
                  ? 'h-[392px]'
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
      widthPx={isAgentsUsage ? (isOnboardingUsage ? 340 : 400) : isAgentsStatuses ? 420 : undefined}
      heightPx={isAgentsStatuses ? 250 : undefined}
    />
  ) : null
  const animatedVisualNode = (
    <div
      className={cn(
        'flex w-full items-start justify-center',
        visualStageHeight,
        settingBesideVisual ? 'self-center' : null
      )}
    >
      <div
        className={cn(
          'max-w-full',
          animatedVisualWidth,
          isAgentsOrchestration ? 'translate-x-6' : null
        )}
      >
        {animatedVisual}
      </div>
    </div>
  )

  return (
    <div className={cn('flex flex-col gap-5 px-9 pt-1', isTasks ? 'pb-3' : 'pb-9')}>
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
          settingContent && settingBesideVisual ? (
            <div className="@container w-full">
              <div
                className={cn(
                  'grid w-full items-start',
                  isOnboardingOrchestrationBesideVisual ||
                    isOnboardingWorkbenchBrowser ||
                    (isCompactBesideVisual && isReviewSettingBesideVisual)
                    ? 'gap-4'
                    : 'gap-5',
                  settingBesideVisual ? 'justify-between' : 'justify-center',
                  isAgentsUsage
                    ? isOnboardingUsage
                      ? '@[780px]:grid-cols-[minmax(360px,400px)_minmax(320px,340px)] @[780px]:items-center'
                      : '@[860px]:grid-cols-[minmax(400px,440px)_minmax(360px,400px)] @[860px]:items-center'
                    : isWorkbenchBrowser
                      ? isOnboardingWorkbenchBrowser
                        ? '@[800px]:grid-cols-[minmax(320px,340px)_minmax(440px,460px)] @[800px]:items-center'
                        : '@[880px]:grid-cols-[minmax(360px,400px)_minmax(440px,480px)] @[880px]:items-center'
                      : isOnboardingOrchestrationBesideVisual
                        ? '@[800px]:grid-cols-[minmax(340px,360px)_minmax(420px,440px)] @[800px]:items-center'
                        : isReviewSettingBesideVisual
                          ? isCompactBesideVisual
                            ? '@[800px]:grid-cols-[minmax(300px,320px)_minmax(460px,480px)] @[800px]:items-center'
                            : cn(
                                '@[840px]:grid-cols-[minmax(380px,420px)_minmax(440px,480px)]',
                                isReviewShip ? '@[840px]:items-start' : '@[840px]:items-center'
                              )
                          : isCompactBesideVisual
                            ? '@[700px]:grid-cols-[minmax(300px,340px)_minmax(320px,340px)] @[700px]:items-center'
                            : isAgentsOrchestration
                              ? '@[860px]:grid-cols-[minmax(340px,380px)_auto] @[860px]:items-center'
                              : '@[760px]:grid-cols-[auto_minmax(320px,420px)] @[760px]:items-center'
                )}
              >
                <div
                  className={cn(
                    'w-full',
                    isReviewShip ? 'translate-y-0.5 self-start' : 'self-center',
                    isAgentsUsage
                      ? isOnboardingUsage
                        ? 'max-w-[400px]'
                        : 'max-w-[440px]'
                      : isWorkbenchBrowser
                        ? isOnboardingWorkbenchBrowser
                          ? 'max-w-[340px]'
                          : 'max-w-[400px]'
                        : isOnboardingOrchestrationBesideVisual
                          ? 'max-w-[360px]'
                          : isCompactBesideVisual
                            ? isReviewSettingBesideVisual
                              ? 'max-w-[320px]'
                              : 'max-w-[340px]'
                            : isAgentsOrchestration
                              ? 'max-w-[400px]'
                              : isReviewSettingBesideVisual
                                ? 'max-w-[420px]'
                                : 'max-w-[420px]'
                  )}
                >
                  {settingContent}
                </div>
                {animatedVisualNode}
              </div>
            </div>
          ) : (
            animatedVisualNode
          )
        ) : (
          <aside className="flex flex-col gap-5">
            {selected.relatedTileIds.length > 0 ? (
              <RelatedFeatures workflow={selected} source={source} />
            ) : null}
          </aside>
        )}
      </div>
      {settingContent && !settingBesideVisual ? (
        <div className={cn('mx-auto w-full', settingWidth)}>{settingContent}</div>
      ) : null}
    </div>
  )
}
