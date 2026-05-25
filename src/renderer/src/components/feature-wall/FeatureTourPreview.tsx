import type { JSX } from 'react'
import { cn } from '@/lib/utils'
import { ClaudeIcon, OpenCodeGoIcon } from '../status-bar/icons'

function CodexInlineIcon(): JSX.Element {
  return (
    <svg
      width={12}
      height={12}
      viewBox="0 0 24 24"
      aria-hidden
      focusable="false"
      className="text-foreground"
    >
      <path
        fill="currentColor"
        d="M9.205 8.658v-2.26c0-.19.072-.333.238-.428l4.543-2.616c.619-.357 1.356-.523 2.117-.523 2.854 0 4.662 2.212 4.662 4.566 0 .167 0 .357-.024.547l-4.71-2.759a.797.797 0 00-.856 0l-5.97 3.473zm10.609 8.8V12.06c0-.333-.143-.57-.429-.737l-5.97-3.473 1.95-1.118a.433.433 0 01.476 0l4.543 2.617c1.309.76 2.189 2.378 2.189 3.948 0 1.808-1.07 3.473-2.76 4.163zM7.802 12.703l-1.95-1.142c-.167-.095-.239-.238-.239-.428V5.899c0-2.545 1.95-4.472 4.591-4.472 1 0 1.927.333 2.712.928L8.23 5.067c-.285.166-.428.404-.428.737v6.898zM12 15.128l-2.795-1.57v-3.33L12 8.658l2.795 1.57v3.33L12 15.128zm1.796 7.23c-1 0-1.927-.332-2.712-.927l4.686-2.712c.285-.166.428-.404.428-.737v-6.898l1.974 1.142c.167.095.238.238.238.428v5.233c0 2.545-1.974 4.472-4.614 4.472zm-5.637-5.303l-4.544-2.617c-1.308-.761-2.188-2.378-2.188-3.948A4.482 4.482 0 014.21 6.327v5.423c0 .333.143.571.428.738l5.947 3.449-1.95 1.118a.432.432 0 01-.476 0zm-.262 3.9c-2.688 0-4.662-2.021-4.662-4.519 0-.19.024-.38.047-.57l4.686 2.71c.286.167.571.167.856 0l5.97-3.448v2.26c0 .19-.07.333-.237.428l-4.543 2.616c-.619.357-1.356.523-2.117.523zm5.899 2.83a5.947 5.947 0 005.827-4.756C22.287 18.339 24 15.84 24 13.296c0-1.665-.713-3.282-1.998-4.448.119-.5.19-.999.19-1.498 0-3.401-2.759-5.947-5.946-5.947-.642 0-1.26.095-1.88.31A5.962 5.962 0 0010.205 0a5.947 5.947 0 00-5.827 4.757C1.713 5.447 0 7.945 0 10.49c0 1.666.713 3.283 1.998 4.448-.119.5-.19 1-.19 1.499 0 3.401 2.759 5.946 5.946 5.946.642 0 1.26-.095 1.88-.309a5.96 5.96 0 004.162 1.713z"
      />
    </svg>
  )
}

type FrameId = 1 | 2 | 3 | 4

export type FeatureTourPreviewFrameCopy = {
  id: FrameId
  title: string
  caption: string
}

export const FEATURE_TOUR_PREVIEW_COPY: readonly FeatureTourPreviewFrameCopy[] = [
  {
    id: 1,
    title: 'Isolated workspaces',
    caption:
      'Ship several things at once. Each task runs in its own branch, terminal, and agent — no cross-talk.'
  },
  {
    id: 2,
    title: 'Agent orchestration',
    caption: 'Hand off a goal and walk away. A coordinator agent fans out and ships parallel PRs.'
  },
  {
    id: 3,
    title: 'GitHub & Linear tasks',
    caption:
      'Skip the tab-switching. Pick from your GitHub or Linear backlog and start a workspace in one click.'
  },
  {
    id: 4,
    title: 'Splittable terminal',
    caption:
      'Run tests, dev servers, and agents side by side — your shell and profile in every workspace.'
  }
]

function WorkingSpinner({ size = 'sm' }: { size?: 'sm' | 'xs' }): JSX.Element {
  // Why: matches AgentStateDot's working indicator so the preview teaches
  // the same state language users see in the real app.
  const ring = size === 'xs' ? 'size-1.5 border' : 'size-2 border-2'
  return (
    <span
      className={cn(
        'inline-block shrink-0 rounded-full border-yellow-500 border-t-transparent animate-spin',
        ring
      )}
      aria-hidden
    />
  )
}

function CursorIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" aria-hidden focusable="false">
      <path
        d="M2 1.5 L2 12 L5 9 L7.2 14.5 L9.5 13.6 L7.3 8 L11.5 8 Z"
        className="fill-background stroke-foreground"
        strokeWidth={1}
        strokeLinejoin="round"
      />
    </svg>
  )
}

function MailGlyph(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" aria-hidden width="9" height="9" fill="none" strokeWidth={1.6}>
      <rect x="3" y="5" width="18" height="14" rx="2" stroke="currentColor" />
      <path d="M3 7l9 6 9-6" stroke="currentColor" />
    </svg>
  )
}

function WorkspaceFrame(): JSX.Element {
  return (
    <div className="absolute inset-0 flex flex-col gap-1.5 bg-card p-3">
      <div className="text-[10px] font-semibold uppercase tracking-[0.07em] leading-none text-muted-foreground">
        Isolated workspaces
      </div>
      <div className="rounded-md border border-border bg-background px-2 py-1.5">
        <div className="flex items-center gap-2">
          <WorkingSpinner />
          <span className="truncate text-[11px] font-medium leading-none text-foreground">
            fix login race condition
          </span>
        </div>
        <div className="mt-1.5 flex flex-col gap-1.5 pl-3.5">
          <div className="flex items-center gap-2">
            <WorkingSpinner size="xs" />
            <ClaudeIcon size={12} />
            <span className="h-1.5 w-[55%] rounded-full bg-foreground/15" />
          </div>
          <div className="flex items-center gap-2">
            <WorkingSpinner size="xs" />
            <CodexInlineIcon />
            <span className="h-1.5 w-[48%] rounded-full bg-foreground/15" />
          </div>
        </div>
      </div>
      <div className="rounded-md border border-border/70 bg-background px-2 py-1.5">
        <div className="flex items-center gap-2">
          <span className="size-2 rounded-full bg-emerald-500" />
          <span className="truncate text-[11px] leading-none text-muted-foreground">
            speed up CI pipeline
          </span>
        </div>
        <div className="mt-1.5 flex flex-col gap-1.5 pl-3.5">
          <div className="flex items-center gap-2">
            <span className="inline-block size-1.5 rounded-full bg-emerald-500" />
            <OpenCodeGoIcon size={12} />
            <span className="h-1.5 w-[42%] rounded-full bg-foreground/15" />
          </div>
        </div>
      </div>
    </div>
  )
}

function OrchestrationFrame(): JSX.Element {
  return (
    <div className="absolute inset-0 flex flex-col gap-1.5 bg-card p-3">
      <div className="text-[10px] font-semibold uppercase tracking-[0.07em] leading-none text-muted-foreground">
        Agent orchestration
      </div>
      <div className="relative w-full flex-1">
        <svg
          className="pointer-events-none absolute inset-0 text-foreground/20"
          viewBox="0 0 332 130"
          preserveAspectRatio="none"
          aria-hidden
        >
          <path
            d="M 166 36 C 130 56, 100 66, 72 86"
            fill="none"
            stroke="currentColor"
            strokeWidth="1"
            strokeDasharray="2 3"
          />
          <path
            d="M 166 36 C 202 56, 232 66, 260 86"
            fill="none"
            stroke="currentColor"
            strokeWidth="1"
            strokeDasharray="2 3"
          />
        </svg>

        <div className="absolute left-12 right-12 top-1 flex h-7 items-center gap-2 rounded-md border border-border bg-background px-2.5">
          <span className="font-mono text-[9.5px] text-muted-foreground">redesign auth flow</span>
          <span className="h-1.5 flex-1 rounded-full bg-foreground/12" />
          <WorkingSpinner />
        </div>

        <div className="absolute left-1/2 top-[42px] -translate-x-1/2 rounded-full border border-border bg-muted px-1.5 py-px font-sans text-[9.5px] leading-none text-muted-foreground">
          2 children
        </div>

        <div className="feature-tour-orch-child absolute left-0 top-[78px] flex h-7 w-[120px] items-center gap-2 rounded-md border border-border bg-background px-2.5">
          <span className="font-mono text-[10px] leading-none text-muted-foreground">PR 1/2</span>
          <span className="h-1.5 flex-1 rounded-full bg-foreground/12" />
        </div>
        <div className="feature-tour-orch-child right absolute right-0 top-[78px] flex h-7 w-[120px] items-center gap-2 rounded-md border border-border bg-background px-2.5">
          <span className="font-mono text-[10px] leading-none text-muted-foreground">PR 2/2</span>
          <span className="h-1.5 flex-1 rounded-full bg-foreground/12" />
        </div>

        <div className="feature-tour-orch-bubble left">
          <MailGlyph />
        </div>
        <div className="feature-tour-orch-bubble right">
          <MailGlyph />
        </div>
        <div className="feature-tour-orch-bubble left b2">
          <MailGlyph />
        </div>
        <div className="feature-tour-orch-bubble right b2">
          <MailGlyph />
        </div>
      </div>
    </div>
  )
}

function TasksFrame(): JSX.Element {
  return (
    <div className="absolute inset-0 flex flex-col gap-1 bg-card px-3 pb-3 pt-2.5">
      <div className="px-2.5 pb-1 text-[10px] font-semibold uppercase tracking-[0.07em] leading-none text-muted-foreground">
        GitHub & Linear tasks
      </div>
      <div className="grid h-[26px] grid-cols-[34px_minmax(0,1fr)_auto] items-center gap-2.5 rounded-md px-2.5">
        <span className="inline-flex h-3.5 w-[30px] items-center justify-center rounded-[3px] border border-border bg-muted font-mono text-[9px] leading-none text-muted-foreground">
          #1799
        </span>
        <span className="truncate text-[11px] leading-none text-muted-foreground">
          Bulk archive in source control
        </span>
        <span className="h-4 w-9 rounded-full border border-emerald-500/30 bg-emerald-500/15" />
      </div>
      <div className="feature-tour-tasks-row relative grid h-[26px] grid-cols-[34px_minmax(0,1fr)_auto] items-center gap-2.5 rounded-md px-2.5">
        <span className="inline-flex h-3.5 w-[30px] items-center justify-center rounded-[3px] border border-border bg-muted font-mono text-[9px] leading-none text-muted-foreground">
          #1842
        </span>
        <span className="truncate text-[11px] font-medium leading-none text-foreground">
          Worktree picker truncates
        </span>
        <span className="feature-tour-tasks-pill relative flex h-4 items-center justify-center overflow-hidden rounded-full border border-emerald-500/30 bg-emerald-500/15">
          <span className="feature-tour-tasks-pill-label whitespace-nowrap text-[10px] font-medium leading-none text-primary-foreground">
            Start workspace →
          </span>
        </span>
      </div>
      <div className="feature-tour-tasks-workspace mt-1.5 flex items-center gap-2 rounded-md border border-border bg-background px-2.5 py-1.5">
        <WorkingSpinner />
        <span className="truncate text-[10.5px] font-medium leading-none text-foreground">
          fix/worktree-picker-truncates
        </span>
        <span className="ml-auto inline-flex items-center gap-1">
          <ClaudeIcon size={11} />
        </span>
      </div>
      <span className="feature-tour-tasks-cursor">
        <CursorIcon />
      </span>
      <span className="feature-tour-tasks-click-ring" aria-hidden />
    </div>
  )
}

function TerminalFrame(): JSX.Element {
  return (
    <div className="absolute inset-0 flex flex-col gap-1.5 bg-card p-3">
      <div className="text-[10px] font-semibold uppercase tracking-[0.07em] leading-none text-muted-foreground">
        Splittable terminal
      </div>
      <div className="flex h-[136px] flex-col overflow-hidden rounded-md border border-border bg-background">
        <div className="flex items-center gap-1.5 border-b border-border bg-muted/40 px-2 py-1">
          <span className="size-1.5 rounded-full bg-foreground/15" />
          <span className="size-1.5 rounded-full bg-foreground/15" />
          <span className="size-1.5 rounded-full bg-foreground/15" />
          <span className="ml-2 font-mono text-[9px] leading-none text-muted-foreground">
            orca · zsh
          </span>
        </div>
        <div className="grid flex-1 grid-cols-2 divide-x divide-border font-mono text-[10px] leading-[1.4] text-foreground">
          <div className="min-w-0 p-2">
            <div className="flex items-center gap-1">
              <span className="text-emerald-500">$</span>
              <span className="feature-tour-terminal-line relative inline-block whitespace-nowrap text-foreground">
                pnpm playwright test
              </span>
            </div>
            <div className="mt-1.5 flex flex-col gap-1">
              <div
                className="feature-tour-terminal-output truncate text-muted-foreground"
                data-line="1"
              >
                Running 12 tests
              </div>
              <div
                className="feature-tour-terminal-output flex min-w-0 items-center gap-1.5"
                data-line="2"
              >
                <span className="font-bold text-emerald-600">✓</span>
                <span className="truncate">login.spec.ts</span>
              </div>
              <div
                className="feature-tour-terminal-output flex min-w-0 items-center gap-1.5"
                data-line="3"
              >
                <span className="inline-block size-2 animate-spin rounded-full border-[1.5px] border-foreground/20 border-t-foreground" />
                <span className="truncate">dashboard.spec.ts</span>
              </div>
            </div>
          </div>
          <div className="min-w-0 p-2">
            <div className="flex items-center gap-1">
              <span className="text-emerald-500">$</span>
              <span className="text-foreground">claude</span>
            </div>
            <div className="mt-1.5 flex flex-col gap-1">
              <div
                className="feature-tour-terminal-output flex min-w-0 items-center gap-1.5"
                data-line="1"
              >
                <ClaudeIcon size={10} />
                <span className="truncate text-muted-foreground">session started</span>
              </div>
              <div
                className="feature-tour-terminal-output flex min-w-0 items-center gap-1"
                data-line="2"
              >
                <span className="text-amber-600">&gt;</span>
                <span className="truncate">review src/auth</span>
              </div>
              <div
                className="feature-tour-terminal-output flex min-w-0 items-center gap-1.5"
                data-line="3"
              >
                <span className="inline-block size-2 animate-spin rounded-full border-[1.5px] border-amber-600/20 border-t-amber-600" />
                <span className="truncate text-muted-foreground">Thinking...</span>
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
        'relative h-[180px] w-full overflow-hidden rounded-lg border border-border bg-muted/40',
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
      <div className="absolute inset-x-0 bottom-1.5 z-[5] flex items-center justify-center gap-1.5">
        <span className="feature-tour-dot" data-frame="1" />
        <span className="feature-tour-dot" data-frame="2" />
        <span className="feature-tour-dot" data-frame="3" />
        <span className="feature-tour-dot" data-frame="4" />
      </div>
    </div>
  )
}
