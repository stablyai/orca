import type { JSX, ReactNode } from 'react'
import type {
  FeatureWallWorkflow,
  FeatureWallWorkflowBullet
} from '../../../../shared/feature-wall-workflows'
import type { FeatureWallOpenSourceTelemetry } from '../../../../shared/telemetry-events'
import type { AgentsStep, AgentsStepBullet } from '../../../../shared/agents-orchestration-steps'
import type { WorkbenchStep } from '../../../../shared/workbench-steps'
import type { ReviewStep } from '../../../../shared/review-steps'
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
import { OrcaCliSkillSetupCard } from './OrcaCliSkillSetupCard'
import { UsageAccountsCard } from './agents-orchestration/UsageAccountsCard'
import { AiCommitPrSettingsCard } from './AiCommitPrSettingsCard'

// Mac users see ⌘/⇧ glyphs, everyone else gets Ctrl+/Shift+ — matches the
// existing convention used elsewhere in the renderer.
const isMacPlatform = typeof navigator !== 'undefined' && navigator.userAgent.includes('Mac')
const MOD_KEY_LABEL = isMacPlatform ? '⌘' : 'Ctrl+'
const SHIFT_KEY_LABEL = isMacPlatform ? '⇧' : 'Shift+'

const KBD_CLASS =
  'rounded border border-border bg-card px-1.5 py-0.5 font-mono text-[11.5px] text-foreground'

function Bullet(props: { children: ReactNode; className?: string }): JSX.Element {
  return (
    <li className={cn('flex items-start gap-2.5 text-[17px] leading-relaxed', props.className)}>
      <span className="mt-[9px] inline-block size-1.5 shrink-0 rounded-full bg-foreground/40" />
      <span>{props.children}</span>
    </li>
  )
}

function workflowBulletKey(bullet: FeatureWallWorkflowBullet): string {
  return typeof bullet === 'string' ? bullet : bullet.leadIn
}

// Replace ⌘D / ⌘⇧D / ⌘⇧↑ etc. glyph runs with platform-aware kbd chips so the
// non-Mac copy reads "Ctrl+D / Ctrl+Shift+D" while the Mac copy keeps the
// compact symbol pattern.
function renderShortcutChips(text: string): ReactNode {
  const parts = text.split(/(⌘⇧?[A-Za-z↑↓←→])/g)
  return parts.map((part, i) => {
    if (!part.startsWith('⌘')) {
      return <span key={i}>{part}</span>
    }
    const hasShift = part.includes('⇧')
    const final = part.replace('⌘', '').replace('⇧', '')
    return (
      <kbd key={i} className={KBD_CLASS}>
        {MOD_KEY_LABEL}
        {hasShift ? SHIFT_KEY_LABEL : null}
        {final}
      </kbd>
    )
  })
}

function WorkflowBulletContent(props: { bullet: FeatureWallWorkflowBullet }): JSX.Element {
  const { bullet } = props
  if (typeof bullet === 'string') {
    return <>{renderShortcutChips(bullet)}</>
  }
  return (
    <>
      <strong className="font-semibold">{bullet.leadIn}</strong> {renderShortcutChips(bullet.body)}
    </>
  )
}

function BulletList(props: { bullets: readonly FeatureWallWorkflowBullet[] }): JSX.Element {
  return (
    <ul className="flex flex-col gap-3" role="list">
      {props.bullets.map((bullet) => (
        <Bullet key={workflowBulletKey(bullet)}>
          <WorkflowBulletContent bullet={bullet} />
        </Bullet>
      ))}
    </ul>
  )
}

// Why: agents-orchestration step 3 mentions the `orca` CLI inline. Render the
// markdown-style backticks as monospace chips so the bullet matches the mock,
// without pulling a full markdown renderer in.
function renderInlineCode(text: string): ReactNode {
  const parts = text.split(/(`[^`]+`)/g)
  return parts.map((part, i) => {
    if (part.startsWith('`') && part.endsWith('`')) {
      return (
        <code
          key={i}
          className="rounded-[4px] bg-foreground/[0.08] px-1.5 py-px font-mono text-[14px]"
        >
          {part.slice(1, -1)}
        </code>
      )
    }
    return <span key={i}>{part}</span>
  })
}

function bulletKey(bullet: AgentsStepBullet): string {
  return typeof bullet === 'string' ? bullet : bullet.leadIn
}

function StepBulletList(props: {
  leadIn?: string
  bullets: readonly AgentsStepBullet[]
}): JSX.Element {
  const { leadIn, bullets } = props
  return (
    <div className="flex flex-col gap-3">
      {leadIn ? <p className="text-[17px] leading-relaxed">{leadIn}</p> : null}
      <ul className="flex flex-col gap-3" role="list">
        {bullets.map((bullet) => (
          <Bullet key={bulletKey(bullet)}>
            {typeof bullet === 'string' ? (
              renderInlineCode(bullet)
            ) : (
              <>
                <strong className="font-semibold">{bullet.leadIn}</strong>{' '}
                {renderInlineCode(bullet.body)}
              </>
            )}
          </Bullet>
        ))}
      </ul>
    </div>
  )
}

function SectionIntro(props: {
  title?: string
  description: string
  optional?: boolean
}): JSX.Element {
  return (
    <div>
      {props.title ? (
        <div className="flex flex-wrap items-center gap-2">
          <div className="text-xl font-semibold leading-snug tracking-tight text-foreground">
            {props.title}
          </div>
          {props.optional ? (
            <span className="rounded-full border border-border bg-background px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
              Optional
            </span>
          ) : null}
        </div>
      ) : null}
      <p
        className={cn(
          props.title ? 'mt-1.5' : null,
          'text-[15px] leading-relaxed text-muted-foreground'
        )}
      >
        {props.description}
      </p>
    </div>
  )
}

function WorkspaceShortcutsCopy(): JSX.Element {
  return (
    <>
      <kbd className={KBD_CLASS}>{MOD_KEY_LABEL}J</kbd> jumps to any workspace;{' '}
      <kbd className={KBD_CLASS}>
        {MOD_KEY_LABEL}
        {SHIFT_KEY_LABEL}↑
      </kbd>{' '}
      /{' '}
      <kbd className={KBD_CLASS}>
        {MOD_KEY_LABEL}
        {SHIFT_KEY_LABEL}↓
      </kbd>{' '}
      moves between them.
    </>
  )
}

export function FeatureWallBody(props: {
  selected: FeatureWallWorkflow
  selectedPresentation: FeatureWallWorkflow
  posterUrl: string | null
  gifUrl: string | null
  showGif: boolean
  prefersReducedMotion: boolean
  source: FeatureWallOpenSourceTelemetry
  agentsActiveStep: AgentsStep | null
  workbenchActiveStep: WorkbenchStep | null
  reviewActiveStep: ReviewStep | null
  onOrchestrationSkillInstalledChange: (installed: boolean) => void
}): JSX.Element {
  const {
    selected,
    selectedPresentation,
    posterUrl,
    gifUrl,
    showGif,
    prefersReducedMotion,
    source,
    agentsActiveStep,
    workbenchActiveStep,
    reviewActiveStep,
    onOrchestrationSkillInstalledChange
  } = props
  const isWorkspaces = selected.id === 'workspaces'
  const isTasks = selected.id === 'tasks'
  const isAgents = selected.id === 'agents-orchestration'
  const isWorkbench = selected.id === 'workbench'
  const isReview = selected.id === 'review'
  const isAgentsUsage = isAgents && agentsActiveStep?.id === 'usage'
  const isAgentsStatuses = isAgents && agentsActiveStep?.id === 'statuses'
  const isAgentsOrchestration = isAgents && agentsActiveStep?.id === 'orchestration'
  const isAgentsNotifications = isAgents && agentsActiveStep?.id === 'notifications'
  const isWorkbenchEditor = isWorkbench && workbenchActiveStep?.id === 'editor'
  const isWorkbenchBrowser = isWorkbench && workbenchActiveStep?.id === 'browser'
  const isReviewPrView = isReview && reviewActiveStep?.id === 'pr-view'
  const isReviewShip = isReview && reviewActiveStep?.id === 'ship'
  const hasAnimatedVisual = isWorkspaces || isTasks || isAgents || isWorkbench || isReview
  const centerSetupBelowAnimation = isAgentsOrchestration || isWorkbenchBrowser

  const visibleAgentsBullets = agentsActiveStep?.bullets ?? null
  const agentsLeadIn = agentsActiveStep?.bulletsLeadIn
  const visibleWorkbenchBullets = workbenchActiveStep?.bullets ?? null
  const visibleReviewBullets = reviewActiveStep?.bullets ?? null

  return (
    <div
      className={cn(
        'flex flex-col gap-6 px-9 pt-3',
        isTasks || centerSetupBelowAnimation ? 'h-full min-h-0' : null,
        isTasks ? 'pb-3' : 'pb-9'
      )}
    >
      <div
        className={cn(
          'grid grid-cols-1 items-start gap-7',
          centerSetupBelowAnimation && 'min-h-0 flex-1',
          hasAnimatedVisual
            ? 'lg:grid-cols-[minmax(0,1fr)_auto]'
            : 'lg:grid-cols-[minmax(0,1fr)_320px]'
        )}
      >
        {hasAnimatedVisual ? (
          <aside className="order-2 flex min-w-0 flex-col gap-5 lg:order-1">
            {isAgents && agentsActiveStep ? (
              <SectionIntro
                title={agentsActiveStep.subtitle}
                description={agentsActiveStep.description}
                optional={agentsActiveStep.optional}
              />
            ) : null}
            {isWorkbench && workbenchActiveStep ? (
              <SectionIntro
                title={workbenchActiveStep.subtitle}
                description={workbenchActiveStep.description}
              />
            ) : null}
            {isReview && reviewActiveStep ? (
              <SectionIntro
                title={reviewActiveStep.subtitle}
                description={reviewActiveStep.description}
              />
            ) : null}
            {(isWorkspaces || isTasks) && !agentsActiveStep && !workbenchActiveStep ? (
              <SectionIntro description={selectedPresentation.lede} />
            ) : null}
            {isAgents && visibleAgentsBullets && agentsActiveStep ? (
              <StepBulletList leadIn={agentsLeadIn} bullets={visibleAgentsBullets} />
            ) : isWorkbench && visibleWorkbenchBullets ? (
              <StepBulletList
                leadIn={workbenchActiveStep?.bulletsLeadIn}
                bullets={visibleWorkbenchBullets}
              />
            ) : isReview && visibleReviewBullets ? (
              <StepBulletList
                leadIn={reviewActiveStep?.bulletsLeadIn}
                bullets={visibleReviewBullets}
              />
            ) : (
              <ul className="flex flex-col gap-3" role="list">
                {selectedPresentation.bullets.map((bullet) => (
                  <Bullet key={workflowBulletKey(bullet)}>
                    <WorkflowBulletContent bullet={bullet} />
                  </Bullet>
                ))}
                {isWorkspaces ? (
                  <Bullet>
                    <WorkspaceShortcutsCopy />
                  </Bullet>
                ) : null}
              </ul>
            )}
            {isAgentsUsage ? <UsageAccountsCard /> : null}
            {isReviewPrView ? <GitHubRow compact /> : null}
            {isReviewShip ? <AiCommitPrSettingsCard /> : null}
          </aside>
        ) : (
          <PreviewMedia
            key={selected.id}
            posterUrl={posterUrl}
            gifUrl={gifUrl}
            showGif={showGif}
            workflowTitle={selected.title}
          />
        )}

        {hasAnimatedVisual ? (
          <div
            className={cn(
              'order-1 flex justify-end lg:order-2',
              centerSetupBelowAnimation ? 'self-stretch' : null
            )}
          >
            <div
              className={cn(
                'max-w-full',
                centerSetupBelowAnimation ? 'flex h-full flex-col' : null,
                isWorkspaces
                  ? 'w-[440px]'
                  : isWorkbenchEditor
                    ? 'w-[600px]'
                    : isWorkbenchBrowser
                      ? 'w-[480px]'
                      : isWorkbench
                        ? 'w-[560px]'
                        : isReview
                          ? 'w-[480px]'
                          : isAgentsUsage
                            ? 'w-[400px]'
                            : isAgentsStatuses
                              ? 'w-[420px]'
                              : isAgentsNotifications
                                ? 'w-[440px]'
                                : isAgentsOrchestration
                                  ? 'w-[480px]'
                                  : 'w-[520px]'
              )}
            >
              {isWorkspaces ? (
                <WorkspacesAnimatedVisual reducedMotion={prefersReducedMotion} />
              ) : isTasks ? (
                <TasksAnimatedVisual reducedMotion={prefersReducedMotion} />
              ) : isReview && reviewActiveStep ? (
                <ReviewAnimatedVisual
                  reducedMotion={prefersReducedMotion}
                  activeStepId={reviewActiveStep.id}
                />
              ) : isWorkbench ? (
                workbenchActiveStep?.id === 'editor' ? (
                  <EditorAnimatedVisual reducedMotion={prefersReducedMotion} />
                ) : isWorkbenchBrowser ? (
                  <>
                    <BrowserAnimatedVisual reducedMotion={prefersReducedMotion} />
                    <OrcaCliSkillSetupCard compact terminalHeightPx={140} />
                  </>
                ) : (
                  <WorkbenchAnimatedVisual reducedMotion={prefersReducedMotion} />
                )
              ) : isAgentsOrchestration && agentsActiveStep ? (
                <>
                  <AgentsOrchestrationVisual
                    reducedMotion={prefersReducedMotion}
                    activeStepId={agentsActiveStep.id}
                    widthPx={480}
                    heightPx={235}
                  />
                  <OrchestrationSetupCard
                    compact
                    terminalHeightPx={140}
                    onInstalledChange={onOrchestrationSkillInstalledChange}
                  />
                </>
              ) : agentsActiveStep ? (
                <AgentsOrchestrationVisual
                  reducedMotion={prefersReducedMotion}
                  activeStepId={agentsActiveStep.id}
                  widthPx={
                    isAgentsUsage
                      ? 400
                      : isAgentsStatuses
                        ? 420
                        : isAgentsNotifications
                          ? 440
                          : undefined
                  }
                />
              ) : null}
            </div>
          </div>
        ) : (
          <aside className="flex flex-col gap-5">
            <BulletList bullets={selectedPresentation.bullets} />
            {selected.relatedTileIds.length > 0 ? (
              <RelatedFeatures workflow={selected} source={source} />
            ) : null}
          </aside>
        )}
      </div>
      {isTasks ? (
        <div className="mt-auto grid grid-cols-1 gap-3 md:grid-cols-2">
          <LinearRow compact />
          <GitHubRow compact />
        </div>
      ) : null}
    </div>
  )
}
