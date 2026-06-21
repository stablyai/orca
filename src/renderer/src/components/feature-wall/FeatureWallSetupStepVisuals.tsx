import type { JSX } from 'react'
import { Check, FolderGit2, MousePointer2 } from 'lucide-react'
import { cn } from '@/lib/utils'

// Why: these static marks replace storyboarded animations for setup steps whose
// meaning reads instantly as a single mark — quieter than a looping demo.
// Each compresses its step to one recognizable idea drawn from the old animation.

// A green ✓ + skeleton line: the agent-action checklist beat shared by terminal marks.
function CheckLine(props: { className?: string }): JSX.Element {
  return (
    <span className={cn('flex items-center gap-1.5', props.className)}>
      <Check className="size-3 shrink-0 text-emerald-500" strokeWidth={3} />
      <span className="h-[5px] flex-1 rounded-full bg-foreground/10" />
    </span>
  )
}

// Mac-style terminal traffic-light dots — the signature of an Orca terminal pane.
function TerminalDots(): JSX.Element {
  return (
    <span className="flex gap-[3px]">
      <span className="size-[5px] rounded-full bg-foreground/15" />
      <span className="size-[5px] rounded-full bg-foreground/15" />
      <span className="size-[5px] rounded-full bg-foreground/15" />
    </span>
  )
}

// Split a terminal: one terminal split into two panes, each running an agent.
export function SetupTwoAgentsVisual(): JSX.Element {
  return (
    <div aria-hidden className="relative h-28 w-[156px] shrink-0">
      <div className="absolute inset-y-1 inset-x-0 flex flex-col overflow-hidden rounded-[10px] border-[1.5px] border-border bg-muted shadow-[0_6px_16px_rgba(0,0,0,0.12)]">
        <div className="flex items-center border-b border-border px-2 py-1.5">
          <TerminalDots />
        </div>
        <div className="flex flex-1">
          <SplitTerminalPane />
          <SplitTerminalPane className="border-l-[1.5px] border-border" />
        </div>
      </div>
    </div>
  )
}

function SplitTerminalPane(props: { className?: string }): JSX.Element {
  return (
    <div className={cn('flex flex-1 flex-col gap-1.5 p-2', props.className)}>
      <span className="flex items-center gap-1.5">
        <span className="font-mono text-[11px] leading-none text-muted-foreground">{'>'}</span>
        <span className="h-[5px] w-3/5 rounded-full bg-foreground/10" />
      </span>
      <CheckLine className="w-4/5" />
    </div>
  )
}

// Why: a small, static mark of two parallel worktrees — quieter than an animated
// storyboard, which read as cluttered for a step whose meaning is just "two isolated spaces."
export function SetupWorkspacesVisual(): JSX.Element {
  return (
    <div aria-hidden className="relative h-28 w-[156px] shrink-0">
      <WorktreeGlyphPanel className="right-0 top-0 bg-muted/60" />
      <WorktreeGlyphPanel className="bottom-0 left-0 bg-muted shadow-[0_6px_16px_rgba(0,0,0,0.12)]" />
    </div>
  )
}

function WorktreeGlyphPanel(props: { className?: string }): JSX.Element {
  return (
    <div
      className={cn(
        'absolute flex h-[70px] w-[108px] items-start gap-2 rounded-[10px] border border-border p-3',
        props.className
      )}
    >
      <span className="mt-0.5 size-2 shrink-0 rounded-full bg-emerald-500 ring-[3px] ring-emerald-500/10" />
      <span className="flex min-w-0 flex-1 flex-col gap-1.5">
        <span className="h-[5px] w-4/5 rounded-full bg-foreground/10" />
        <span className="h-[5px] w-1/2 rounded-full bg-foreground/10" />
      </span>
    </div>
  )
}

// Use Orca's browser: a browser pane with a cursor grabbing one highlighted
// element — the point-and-send-to-agent idea compressed into a single mark.
export function SetupBrowserVisual(): JSX.Element {
  return (
    <div aria-hidden className="relative h-28 w-[156px] shrink-0">
      <div className="absolute inset-y-1 inset-x-0 flex flex-col overflow-hidden rounded-[10px] border-[1.5px] border-border bg-muted shadow-[0_6px_16px_rgba(0,0,0,0.12)]">
        <div className="flex items-center gap-1.5 border-b border-border px-2 py-1.5">
          <TerminalDots />
          <span className="ml-1 h-[5px] flex-1 rounded-full bg-foreground/10" />
        </div>
        <div className="flex flex-1 flex-col gap-1.5 p-2">
          <span className="h-[5px] w-1/2 rounded-full bg-foreground/10" />
          <span className="relative mt-0.5 flex h-9 items-center rounded-[6px] border-[1.5px] border-emerald-500/45 bg-emerald-500/10 px-2">
            <span className="h-[5px] w-3/5 rounded-full bg-foreground/15" />
            <MousePointer2 className="absolute -bottom-1 right-1 size-3.5 fill-foreground/70 text-foreground/70" />
          </span>
        </div>
      </div>
    </div>
  )
}

// Start work in multiple repos: two project cards, each a folder + name and a
// live worktree row (emerald dot) — your repos, each running their own work.
export function SetupMultipleReposVisual(): JSX.Element {
  return (
    <div aria-hidden className="flex w-[156px] shrink-0 flex-col gap-2.5">
      <RepoCard nameWidth="w-[62%]" worktreeWidth="w-[78%]" />
      <RepoCard nameWidth="w-[70%]" worktreeWidth="w-[66%]" />
    </div>
  )
}

function RepoCard(props: { nameWidth: string; worktreeWidth: string }): JSX.Element {
  return (
    <div className="flex flex-col gap-2 rounded-[10px] border-[1.5px] border-emerald-500/35 bg-muted p-2.5 shadow-[0_6px_16px_rgba(0,0,0,0.12)]">
      <span className="flex items-center gap-1.5">
        <FolderGit2 className="size-[15px] shrink-0 text-muted-foreground" />
        <span className={cn('h-[5px] rounded-full bg-foreground/10', props.nameWidth)} />
      </span>
      <span className="flex items-center gap-1.5">
        <span className="size-2 shrink-0 rounded-full bg-emerald-500 ring-[3px] ring-emerald-500/10" />
        <span className={cn('h-[5px] rounded-full bg-foreground/10', props.worktreeWidth)} />
      </span>
    </div>
  )
}
