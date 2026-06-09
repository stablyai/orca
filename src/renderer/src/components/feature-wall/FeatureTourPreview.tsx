import type { JSX } from 'react'
import { cn } from '@/lib/utils'
import { ClaudeIcon, OpenCodeGoIcon } from '../status-bar/icons'
import {
  CodexInlineIcon,
  CursorIcon,
  MailGlyph,
  WorkingSpinner
} from './feature-tour-preview-glyphs'
import { FeatureTourWorkspaceCard } from './FeatureTourWorkspaceCard'
import { translate } from '@/i18n/i18n'

type FrameId = 1 | 2 | 3 | 4

export type FeatureTourPreviewFrameCopy = {
  id: FrameId
  title: string
  caption: string
}

export const FEATURE_TOUR_PREVIEW_COPY: readonly FeatureTourPreviewFrameCopy[] = [
  {
    id: 1,
    title: translate("auto.components.feature.wall.FeatureTourPreview.56a0271428", "Isolated workspaces"),
    caption:
      'Ship several things at once. Each workspace keeps its branch, terminal, and agent activity together.'
  },
  {
    id: 2,
    title: translate("auto.components.feature.wall.FeatureTourPreview.e44269e97d", "Agent orchestration"),
    caption: 'Hand off a goal and walk away. A coordinator agent fans out and ships parallel PRs.'
  },
  {
    id: 3,
    title: translate("auto.components.feature.wall.FeatureTourPreview.ef737dcee1", "GitHub & Linear tasks"),
    caption:
      'Skip the tab-switching. Pick from your GitHub or Linear backlog and start a workspace in one click.'
  },
  {
    id: 4,
    title: translate("auto.components.feature.wall.FeatureTourPreview.1aa8a9a24a", "Splittable terminal"),
    caption:
      'Open any workspace to return to its terminal, then split panes for tests, logs, and agents.'
  }
]

function WorkspaceFrame(): JSX.Element {
  return (
    <div className="absolute inset-0 flex flex-col gap-5 bg-card px-4 py-4">
      <div className="text-[14.5px] font-semibold uppercase tracking-[0.07em] leading-none text-muted-foreground">
        {translate("auto.components.feature.wall.FeatureTourPreview.56a0271428", "Isolated workspaces")}</div>
      {/* Why: 3 cards in a row tells the "ship several at once" story by
          composition; the wide preview aspect (~4.9:1) makes a vertical stack
          read as wasted space. The grid auto-sizes (no flex-1) so the cards
          don't stretch to the container's bottom edge — keeps headroom under
          the dot indicators. */}
      <div className="grid grid-cols-3 gap-3 px-4">
        <FeatureTourWorkspaceCard
          status="working"
          title={translate("auto.components.feature.wall.FeatureTourPreview.3c4adfd821", "fix login race condition")}
          agents={[
            { kind: 'claude', barWidth: '60%', state: 'working' },
            { kind: 'codex', barWidth: '52%', state: 'working' }
          ]}
        />
        <FeatureTourWorkspaceCard
          status="done"
          title={translate("auto.components.feature.wall.FeatureTourPreview.9c812e0d7c", "speed up CI pipeline")}
          agents={[{ kind: 'opencode-go', barWidth: '70%', state: 'done' }]}
        />
        <FeatureTourWorkspaceCard
          status="working"
          title={translate("auto.components.feature.wall.FeatureTourPreview.e38112b289", "refactor billing webhook")}
          agents={[{ kind: 'claude', barWidth: '38%', state: 'working' }]}
        />
      </div>
    </div>
  )
}

type OrchChildAgent = 'claude' | 'codex' | 'opencode-go'

const ORCH_CHILDREN: readonly {
  key: 'top' | 'mid' | 'bot'
  position: string
  label: string
  agent: OrchChildAgent
}[] = [
  // Why: card vertical centers anchor to 18% / 50% / 82% — the same Y
  // endpoints the dashed SVG paths terminate at — so the connectors land on
  // each card's center regardless of card height.
  { key: 'top', position: 'top-[18%] -translate-y-1/2', label: translate("auto.components.feature.wall.FeatureTourPreview.b1f17bcc74", "PR 1/3"), agent: 'claude' },
  { key: 'mid', position: 'top-1/2 -translate-y-1/2', label: translate("auto.components.feature.wall.FeatureTourPreview.cfdfd4d6b4", "PR 2/3"), agent: 'codex' },
  { key: 'bot', position: 'top-[82%] -translate-y-1/2', label: translate("auto.components.feature.wall.FeatureTourPreview.ec4a73f5e6", "PR 3/3"), agent: 'opencode-go' }
]

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
        {translate("auto.components.feature.wall.FeatureTourPreview.e44269e97d", "Agent orchestration")}</div>
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
              {translate("auto.components.feature.wall.FeatureTourPreview.cebc7769cd", "redesign auth flow")}</span>
          </div>
          <div className="mt-2 flex items-center gap-1.5 pl-3.5">
            <WorkingSpinner size="xs" />
            <ClaudeIcon size={13} />
            <span className="truncate text-[12.5px] leading-none text-muted-foreground">
              {translate("auto.components.feature.wall.FeatureTourPreview.5171768676", "orchestrating 3 agents")}</span>
          </div>
        </div>

        {/* Why: children mirror the parent's WorkspaceCard composition so the
            fan reads as "coordinator workspace dispatches to 3 child
            workspaces, each running its own agent." */}
        {ORCH_CHILDREN.map(({ key, position, label, agent }) => (
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
              {agent === "claude" ? (
                <ClaudeIcon size={12} />
              ) : agent === "codex" ? (
                <CodexInlineIcon />
              ) : (
                <OpenCodeGoIcon size={12} />
              )}
              <span className="h-2 flex-1 rounded-full bg-foreground/15" />
            </div>
          </div>
        ))}

        {ORCH_CHILDREN.map(({ key }) => (
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
        {translate("auto.components.feature.wall.FeatureTourPreview.bee6b4088d", "GitHub & Linear tasks")}</div>
      <div className="relative grid flex-1 grid-cols-[minmax(0,1fr)_minmax(0,1fr)] items-center gap-4 px-4">
        <div className="flex flex-col gap-2">
          <div className="flex h-9 items-center gap-2.5 rounded-md border border-border bg-background px-3">
            <span className="inline-flex h-5 items-center justify-center rounded-[3px] border border-border bg-muted px-1.5 font-mono text-[13px] leading-none text-muted-foreground">
              {translate("auto.components.feature.wall.FeatureTourPreview.0688842445", "GH #1799")}</span>
            {/* Why: surrounding rows show only the issue number + a skeleton
                so the user's eye is drawn to the row that has real text — the
                one the cursor clicks on. */}
            <span className="h-2 w-[60%] rounded-full bg-foreground/12" />
          </div>
          <div className="feature-tour-tasks-row relative flex h-9 items-center gap-2.5 rounded-md border border-border bg-background px-3">
            <span className="inline-flex h-5 items-center justify-center rounded-[3px] border border-border bg-muted px-1.5 font-mono text-[13px] leading-none text-muted-foreground">
              {translate("auto.components.feature.wall.FeatureTourPreview.fc0cc0b267", "GH #1842")}</span>
            <span className="truncate text-[15px] font-medium leading-none text-foreground">
              {translate("auto.components.feature.wall.FeatureTourPreview.c1f28c03b2", "Worktree picker truncates")}</span>
            <span className="feature-tour-tasks-pill relative ml-auto flex h-6 items-center justify-center overflow-hidden rounded-full border border-emerald-500/30 bg-emerald-500/15">
              <span className="feature-tour-tasks-pill-label flex items-center gap-1 whitespace-nowrap pl-3 pr-2.5 text-[13px] font-semibold leading-none tracking-[0.01em] text-primary-foreground">
                {translate("auto.components.feature.wall.FeatureTourPreview.40bbd92ef4", "Start")}<svg
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
              {translate("auto.components.feature.wall.FeatureTourPreview.d54aefe09e", "LIN-329")}</span>
            <span className="h-2 w-[45%] rounded-full bg-foreground/12" />
          </div>
        </div>

        <div className="feature-tour-tasks-workspace flex flex-col gap-2 rounded-md border border-border bg-background px-4 py-2.5">
          <div className="flex items-center gap-2.5">
            <WorkingSpinner />
            <span className="truncate text-[15.5px] font-medium leading-none text-foreground">
              {translate("auto.components.feature.wall.FeatureTourPreview.3822d8d14b", "fix/worktree-picker-truncates")}</span>
            <span className="ml-auto inline-flex">
              <ClaudeIcon size={13} />
            </span>
          </div>
          <div className="flex items-center gap-2.5 pl-4">
            <WorkingSpinner size="xs" />
            <ClaudeIcon size={12} />
            <span className="h-2 w-[55%] rounded-full bg-foreground/15" />
          </div>
          <div className="text-[13.5px] leading-none text-muted-foreground">{translate("auto.components.feature.wall.FeatureTourPreview.2a7cfc82c8", "Linked to GH #1842")}</div>
        </div>
      </div>
    </div>
  )
}

function TerminalFrame(): JSX.Element {
  return (
    <div className="absolute inset-0 flex flex-col gap-5 bg-card px-4 py-4">
      <div className="text-[14.5px] font-semibold uppercase tracking-[0.07em] leading-none text-muted-foreground">
        {translate("auto.components.feature.wall.FeatureTourPreview.1aa8a9a24a", "Splittable terminal")}</div>
      <div className="mx-4 flex min-h-0 flex-1 flex-col overflow-hidden rounded-md border border-border bg-background">
        <div className="flex items-center gap-1.5 border-b border-border bg-muted/40 px-2 py-1">
          <span className="size-1.5 rounded-full bg-foreground/15" />
          <span className="size-1.5 rounded-full bg-foreground/15" />
          <span className="size-1.5 rounded-full bg-foreground/15" />
          <span className="ml-2 font-mono text-[13.5px] leading-none text-muted-foreground">
            {translate("auto.components.feature.wall.FeatureTourPreview.04d54d50ec", "orca · zsh")}</span>
        </div>
        <div className="grid flex-1 grid-cols-2 divide-x divide-border font-mono text-[14.5px] leading-[1.4] text-foreground">
          <div className="min-w-0 p-2">
            <div className="flex items-center gap-1">
              <span className="text-emerald-500">$</span>
              <span className="feature-tour-terminal-line relative inline-block whitespace-nowrap text-foreground">
                {translate("auto.components.feature.wall.FeatureTourPreview.6218a9014d", "pnpm playwright test")}</span>
            </div>
            <div className="mt-1.5 flex flex-col gap-1">
              <div
                className="feature-tour-terminal-output truncate text-muted-foreground"
                data-line="1"
              >
                {translate("auto.components.feature.wall.FeatureTourPreview.8279e9d95b", "Running 12 tests")}</div>
              <div
                className="feature-tour-terminal-output flex min-w-0 items-center gap-1.5"
                data-line="2"
              >
                <span className="font-bold text-emerald-600">✓</span>
                <span className="truncate">{translate("auto.components.feature.wall.FeatureTourPreview.24fedd5a52", "login.spec.ts")}</span>
              </div>
              <div
                className="feature-tour-terminal-output flex min-w-0 items-center gap-1.5"
                data-line="3"
              >
                <span className="inline-block size-2 animate-spin rounded-full border-[1.5px] border-foreground/20 border-t-foreground" />
                <span className="truncate">{translate("auto.components.feature.wall.FeatureTourPreview.6ed43cb0e0", "dashboard.spec.ts")}</span>
              </div>
            </div>
          </div>
          <div className="min-w-0 p-2">
            <div className="flex items-center gap-1">
              <span className="text-emerald-500">$</span>
              <span className="text-foreground">{translate("auto.components.feature.wall.FeatureTourPreview.771d8881c2", "claude")}</span>
            </div>
            <div className="mt-1.5 flex flex-col gap-1">
              <div
                className="feature-tour-terminal-output flex min-w-0 items-center gap-1.5"
                data-line="1"
              >
                <ClaudeIcon size={12} />
                <span className="truncate text-muted-foreground">{translate("auto.components.feature.wall.FeatureTourPreview.952d3ddd9a", "session started")}</span>
              </div>
              <div
                className="feature-tour-terminal-output flex min-w-0 items-center gap-1"
                data-line="2"
              >
                <span className="text-amber-600">{translate("auto.components.feature.wall.FeatureTourPreview.1170621527", ">")}</span>
                <span className="truncate">{translate("auto.components.feature.wall.FeatureTourPreview.ef8b164dd1", "review src/auth")}</span>
              </div>
              <div
                className="feature-tour-terminal-output flex min-w-0 items-center gap-1.5"
                data-line="3"
              >
                <span className="inline-block size-2 animate-spin rounded-full border-[1.5px] border-amber-600/20 border-t-amber-600" />
                <span className="truncate text-muted-foreground">{translate("auto.components.feature.wall.FeatureTourPreview.304ad0dfc1", "Thinking...")}</span>
              </div>
            </div>
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
        <TerminalFrame />
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
