import type { JSX } from 'react'
import { cn } from '@/lib/utils'
import { ClaudeIcon, OpenCodeGoIcon } from '../status-bar/icons'
import {
  CodexInlineIcon,
  CursorIcon,
  MailGlyph,
  WorkingSpinner
} from './feature-tour-preview-glyphs'
import {
  FEATURE_TOUR_ORCHESTRATION_CHILDREN,
  FEATURE_TOUR_PREVIEW_COPY
} from './feature-tour-preview-copy'
import { FeatureTourWorkspaceCard } from './FeatureTourWorkspaceCard'
import { FeatureTourTerminalFrame } from './FeatureTourTerminalFrame'
import { translate } from '@/i18n/i18n'

export { FEATURE_TOUR_PREVIEW_COPY } from './feature-tour-preview-copy'
export type { FeatureTourPreviewFrameCopy } from './feature-tour-preview-copy'

function WorkspaceFrame(): JSX.Element {
  return (
    <div className="absolute inset-0 flex flex-col gap-5 bg-card px-4 py-4">
      <div className="text-[14.5px] font-semibold uppercase tracking-[0.07em] leading-none text-muted-foreground">
        {translate(
          'auto.components.feature.wall.FeatureTourPreview.56a0271428',
          'Isolated workspaces'
        )}
      </div>
      {/* Why: 3 cards in a row tells the "ship several at once" story by
          composition; the wide preview aspect (~4.9:1) makes a vertical stack
          read as wasted space. The grid auto-sizes (no flex-1) so the cards
          don't stretch to the container's bottom edge — keeps headroom under
          the dot indicators. */}
      <div className="grid grid-cols-3 gap-3 px-4">
        <FeatureTourWorkspaceCard
          status="working"
          title={translate(
            'auto.components.feature.wall.FeatureTourPreview.3c4adfd821',
            'fix login race condition'
          )}
          agents={[
            { kind: 'claude', barWidth: '60%', state: 'working' },
            { kind: 'codex', barWidth: '52%', state: 'working' }
          ]}
        />
        <FeatureTourWorkspaceCard
          status="done"
          title={translate(
            'auto.components.feature.wall.FeatureTourPreview.9c812e0d7c',
            'speed up CI pipeline'
          )}
          agents={[{ kind: 'opencode-go', barWidth: '70%', state: 'done' }]}
        />
        <FeatureTourWorkspaceCard
          status="working"
          title={translate(
            'auto.components.feature.wall.FeatureTourPreview.e38112b289',
            'refactor billing webhook'
          )}
          agents={[{ kind: 'claude', barWidth: '38%', state: 'working' }]}
        />
      </div>
    </div>
  )
}

function OrchestrationFrame(): JSX.Element {
  // Why: a horizontal fan (root → 3 children L→R) reads naturally as
  // "fans out and ships parallel PRs" at the wide aspect; the previous
  // top-down tree wasted the horizontal space. SVG paths are sized to a
  // 600×130 viewBox and stretched non-uniformly, so the dashed lines flex
  // with the container while the absolutely-positioned cards stay aligned
  // to viewport-relative anchors (root left, children right column).
  return (
    <div className="absolute inset-0 flex flex-col gap-5 bg-card px-4 py-4">
      <div className="text-[14.5px] font-semibold uppercase tracking-[0.07em] leading-none text-muted-foreground">
        {translate(
          'auto.components.feature.wall.FeatureTourPreview.e44269e97d',
          'Agent orchestration'
        )}
      </div>
      <div className="relative w-full flex-1">
        {/* Why: viewBox is percent-units (100×100, preserveAspectRatio="none")
            so endpoints anchor to the same percentage anchors as the cards
            and the bubbles — root right edge at 34%, child left edge at 64%,
            child Y centers at 18%/50%/82%. Explicit width/height attrs are
            required because an SVG with a 1:1 viewBox and only inset-0
            otherwise picks its intrinsic 1:1 aspect for height. */}
        <svg
          className="pointer-events-none absolute inset-0 text-foreground/30"
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
          width="100%"
          height="100%"
          aria-hidden
        >
          {/* Why: vectorEffect is NOT inheritable in SVG, so the
              non-scaling-stroke attribute must live on each path. Hoisting
              it onto <g> let preserveAspectRatio="none" stretch the dashes
              into trapezoids on the diagonal connectors. */}
          <path
            d="M 34 50 C 49 50, 49 18, 64 18"
            fill="none"
            stroke="currentColor"
            strokeWidth="1"
            strokeDasharray="2 3"
            vectorEffect="non-scaling-stroke"
          />
          <path
            d="M 34 50 L 64 50"
            fill="none"
            stroke="currentColor"
            strokeWidth="1"
            strokeDasharray="2 3"
            vectorEffect="non-scaling-stroke"
          />
          <path
            d="M 34 50 C 49 50, 49 82, 64 82"
            fill="none"
            stroke="currentColor"
            strokeWidth="1"
            strokeDasharray="2 3"
            vectorEffect="non-scaling-stroke"
          />
        </svg>

        {/* Why: parent matches WorkspaceCard composition — spinner + title row,
            then a Claude agent row underneath — so the user reads it as "a
            workspace running Claude as the orchestrator," consistent with how
            workspaces look elsewhere in the app. */}
        <div className="absolute left-0 top-1/2 flex w-[34%] -translate-y-1/2 flex-col rounded-md border border-border bg-background px-3 py-2">
          <div className="flex items-center gap-2">
            <WorkingSpinner />
            <span className="truncate text-[15px] font-medium leading-none text-foreground">
              {translate(
                'auto.components.feature.wall.FeatureTourPreview.cebc7769cd',
                'redesign auth flow'
              )}
            </span>
          </div>
          <div className="mt-2 flex items-center gap-1.5 pl-3.5">
            <WorkingSpinner size="xs" />
            <ClaudeIcon size={13} />
            <span className="truncate text-[12.5px] leading-none text-muted-foreground">
              {translate(
                'auto.components.feature.wall.FeatureTourPreview.5171768676',
                'orchestrating 3 agents'
              )}
            </span>
          </div>
        </div>

        {/* Why: children mirror the parent's WorkspaceCard composition so the
            fan reads as "coordinator workspace dispatches to 3 child
            workspaces, each running its own agent." */}
        {FEATURE_TOUR_ORCHESTRATION_CHILDREN.map(({ key, position, label, agent }) => (
          <div
            key={key}
            className={cn(
              'feature-tour-orch-child absolute right-0 flex w-[36%] flex-col rounded-md border border-border bg-background px-3 py-2',
              key,
              position
            )}
          >
            <div className="flex items-center gap-2">
              <WorkingSpinner />
              <span className="truncate font-mono text-[14px] font-medium leading-none text-foreground">
                {label}
              </span>
            </div>
            <div className="mt-2 flex items-center gap-1.5 pl-3.5">
              <WorkingSpinner size="xs" />
              {agent === 'claude' ? (
                <ClaudeIcon size={12} />
              ) : agent === 'codex' ? (
                <CodexInlineIcon />
              ) : (
                <OpenCodeGoIcon size={12} />
              )}
              <span className="h-2 flex-1 rounded-full bg-foreground/15" />
            </div>
          </div>
        ))}

        {FEATURE_TOUR_ORCHESTRATION_CHILDREN.map(({ key }) => (
          <div key={`bubble-${key}`} className={cn('feature-tour-orch-bubble', key)}>
            <MailGlyph />
          </div>
        ))}
      </div>
    </div>
  )
}

function TasksFrame(): JSX.Element {
  // Why: a left→right pipeline reads as "pick from backlog → workspace
  // appears" in one glance. The wide aspect lets the backlog and the
  // resulting workspace card sit side-by-side instead of stacked, which
  // makes the cause/effect visible in the composition itself.
  return (
    <div className="absolute inset-0 flex flex-col gap-5 bg-card px-4 py-4">
      <div className="text-[14.5px] font-semibold uppercase tracking-[0.07em] leading-none text-muted-foreground">
        {translate(
          'auto.components.feature.wall.FeatureTourPreview.bee6b4088d',
          'GitHub & Linear tasks'
        )}
      </div>
      <div className="relative grid flex-1 grid-cols-[minmax(0,1fr)_minmax(0,1fr)] items-center gap-4 px-4">
        <div className="flex flex-col gap-2">
          <div className="flex h-9 items-center gap-2.5 rounded-md border border-border bg-background px-3">
            <span className="inline-flex h-5 items-center justify-center rounded-[3px] border border-border bg-muted px-1.5 font-mono text-[13px] leading-none text-muted-foreground">
              {translate('auto.components.feature.wall.FeatureTourPreview.0688842445', 'GH #1799')}
            </span>
            {/* Why: surrounding rows show only the issue number + a skeleton
                so the user's eye is drawn to the row that has real text — the
                one the cursor clicks on. */}
            <span className="h-2 w-[60%] rounded-full bg-foreground/12" />
          </div>
          <div className="feature-tour-tasks-row relative flex h-9 items-center gap-2.5 rounded-md border border-border bg-background px-3">
            <span className="inline-flex h-5 items-center justify-center rounded-[3px] border border-border bg-muted px-1.5 font-mono text-[13px] leading-none text-muted-foreground">
              {translate('auto.components.feature.wall.FeatureTourPreview.fc0cc0b267', 'GH #1842')}
            </span>
            <span className="truncate text-[15px] font-medium leading-none text-foreground">
              {translate(
                'auto.components.feature.wall.FeatureTourPreview.c1f28c03b2',
                'Worktree picker truncates'
              )}
            </span>
            <span className="feature-tour-tasks-pill relative ml-auto flex h-6 items-center justify-center overflow-hidden rounded-full border border-emerald-500/30 bg-emerald-500/15">
              <span className="feature-tour-tasks-pill-label flex items-center gap-1 whitespace-nowrap pl-3 pr-2.5 text-[13px] font-semibold leading-none tracking-[0.01em] text-primary-foreground">
                {translate('auto.components.feature.wall.FeatureTourPreview.40bbd92ef4', 'Start')}
                <svg
                  width="11"
                  height="11"
                  viewBox="0 0 16 16"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden
                >
                  <path d="M3 8h10" />
                  <path d="M9 4l4 4-4 4" />
                </svg>
              </span>
            </span>
            {/* Why: cursor + ring live inside the row so they anchor to the
                pill's right-edge ml-auto, instead of using fixed pixel offsets
                that drift when the preview is resized. */}
            <span className="feature-tour-tasks-cursor">
              <CursorIcon />
            </span>
            <span className="feature-tour-tasks-click-ring" aria-hidden />
          </div>
          <div className="flex h-9 items-center gap-2.5 rounded-md border border-border bg-background px-3">
            <span className="inline-flex h-5 items-center justify-center rounded-[3px] border border-border bg-muted px-1.5 font-mono text-[13px] leading-none text-muted-foreground">
              {translate('auto.components.feature.wall.FeatureTourPreview.d54aefe09e', 'LIN-329')}
            </span>
            <span className="h-2 w-[45%] rounded-full bg-foreground/12" />
          </div>
        </div>

        <div className="feature-tour-tasks-workspace flex flex-col gap-2 rounded-md border border-border bg-background px-4 py-2.5">
          <div className="flex items-center gap-2.5">
            <WorkingSpinner />
            <span className="truncate text-[15.5px] font-medium leading-none text-foreground">
              {translate(
                'auto.components.feature.wall.FeatureTourPreview.3822d8d14b',
                'fix/worktree-picker-truncates'
              )}
            </span>
            <span className="ml-auto inline-flex">
              <ClaudeIcon size={13} />
            </span>
          </div>
          <div className="flex items-center gap-2.5 pl-4">
            <WorkingSpinner size="xs" />
            <ClaudeIcon size={12} />
            <span className="h-2 w-[55%] rounded-full bg-foreground/15" />
          </div>
          <div className="text-[13.5px] leading-none text-muted-foreground">
            {translate(
              'auto.components.feature.wall.FeatureTourPreview.2a7cfc82c8',
              'Linked to GH #1842'
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

export function FeatureTourPreview(props: { className?: string }): JSX.Element {
  return (
    <div
      className={cn(
        'relative h-[260px] w-full overflow-hidden rounded-lg border border-border bg-muted/40',
        props.className
      )}
      aria-hidden
      data-feature-tour-nudge-visual
    >
      <div className="feature-tour-frame" data-frame="1">
        <WorkspaceFrame />
      </div>
      <div className="feature-tour-frame" data-frame="2">
        <OrchestrationFrame />
      </div>
      <div className="feature-tour-frame" data-frame="3">
        <TasksFrame />
      </div>
      <div className="feature-tour-frame" data-frame="4">
        <FeatureTourTerminalFrame />
      </div>
      <div className="pointer-events-none absolute inset-x-0 bottom-0 z-[6] h-[66px] border-t border-border/70 bg-card/95">
        {FEATURE_TOUR_PREVIEW_COPY.map((frame) => (
          <div
            key={frame.id}
            className="feature-tour-copy-slide justify-center px-4 py-2.5 pr-20"
            data-frame={frame.id}
          >
            <div className="truncate text-[13px] font-semibold leading-tight text-foreground">
              {frame.title}
            </div>
            <div className="line-clamp-2 text-[12px] leading-snug text-muted-foreground">
              {frame.caption}
            </div>
          </div>
        ))}
      </div>
      <div className="absolute bottom-3 right-4 z-[7] flex items-center justify-center gap-1.5">
        <span className="feature-tour-dot" data-frame="1" />
        <span className="feature-tour-dot" data-frame="2" />
        <span className="feature-tour-dot" data-frame="3" />
        <span className="feature-tour-dot" data-frame="4" />
      </div>
    </div>
  )
}
