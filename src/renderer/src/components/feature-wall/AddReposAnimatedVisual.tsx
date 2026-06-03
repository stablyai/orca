import { useEffect, useState } from 'react'
import type { JSX, ReactNode } from 'react'
import { FolderGit2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { ClaudeIcon } from '../status-bar/icons'
import { CodexInlineIcon, WorkingSpinner } from './feature-tour-preview-glyphs'

type RepoFocus = 'personal' | 'work' | 'both'

type RepoVisual = {
  id: Exclude<RepoFocus, 'both'>
  name: string
  worktree: string
  prompt: string
  action: string
  agent: 'Claude Code' | 'Codex'
  agentIcon: ReactNode
}

const REPOS: readonly RepoVisual[] = [
  {
    id: 'personal',
    name: 'recipe-box',
    worktree: 'weekend polish',
    prompt: 'refine recipe search',
    action: 'Editing search filters',
    agent: 'Claude Code',
    agentIcon: <ClaudeIcon size={12} />
  },
  {
    id: 'work',
    name: 'billing-app',
    worktree: 'checkout fix',
    prompt: 'fix checkout bug',
    action: 'Updating checkout tests',
    agent: 'Codex',
    agentIcon: <CodexInlineIcon />
  }
]

const FOCUS_SEQUENCE: readonly RepoFocus[] = ['personal', 'both', 'work', 'both', 'both']

export function AddReposAnimatedVisual(props: { reducedMotion: boolean }): JSX.Element {
  const focus = useRepoFocus(props.reducedMotion)

  return (
    <div className="grid min-h-[282px] gap-3 rounded-xl border border-border bg-card p-3 text-foreground shadow-xs md:grid-cols-2">
      {REPOS.map((repo) => (
        <RepoProjectCard
          key={repo.id}
          repo={repo}
          active={focus === repo.id || focus === 'both'}
          reducedMotion={props.reducedMotion}
        />
      ))}
    </div>
  )
}

function RepoProjectCard(props: {
  repo: RepoVisual
  active: boolean
  reducedMotion: boolean
}): JSX.Element {
  return (
    <section
      className={cn(
        'flex min-w-0 flex-col gap-2 rounded-lg border border-sidebar-border bg-sidebar p-2 text-sidebar-foreground transition-[border-color,box-shadow] duration-500',
        props.active ? 'shadow-xs' : null
      )}
    >
      <ProjectSidebarRow name={props.repo.name} />

      <ProjectWorktreeRow
        repo={props.repo}
        active={props.active}
        reducedMotion={props.reducedMotion}
      />

      <div className="min-w-0 overflow-hidden rounded-lg border border-border bg-background text-foreground">
        <VisualTitlebar title={`${props.repo.worktree} - ${props.repo.agent}`} />
        <div className="space-y-1.5 p-2.5 font-mono text-[11px]">
          <TerminalLine>
            <Prompt>&gt;</Prompt>
            {props.repo.prompt}
          </TerminalLine>
          <TerminalLine muted>
            {props.repo.agentIcon}
            {props.repo.agent} session ready
          </TerminalLine>
          <TerminalLine muted>
            <WorkingSpinner size="xs" reducedMotion={props.reducedMotion} />
            {props.repo.action}
          </TerminalLine>
        </div>
      </div>
    </section>
  )
}

function ProjectSidebarRow(props: { name: string }): JSX.Element {
  return (
    <div
      aria-hidden
      className="relative flex h-8 min-w-0 items-center gap-1.5 rounded-md px-1.5 text-sidebar-foreground"
    >
      <span className="flex size-4 shrink-0 items-center justify-center text-muted-foreground">
        <FolderGit2 className="size-3.5" />
      </span>
      <span className="min-w-0 flex-1 truncate text-[13px] font-semibold leading-none">
        {props.name}
      </span>
      <span className="min-w-[3.75rem] rounded-full bg-sidebar-accent px-1.5 py-0.5 text-center text-[9px] font-medium leading-none text-muted-foreground">
        1 worktree
      </span>
    </div>
  )
}

function ProjectWorktreeRow(props: {
  repo: RepoVisual
  active: boolean
  reducedMotion: boolean
}): JSX.Element {
  return (
    <div
      className={cn(
        'rounded-md border border-sidebar-border px-2.5 py-2 transition-colors',
        props.active ? 'bg-sidebar-accent' : 'bg-sidebar'
      )}
    >
      <div className="flex items-center gap-2">
        <span
          className={cn(
            'size-1.5 shrink-0 rounded-full',
            props.active ? 'bg-emerald-500' : 'bg-muted-foreground/35'
          )}
        />
        <span className="truncate text-xs font-medium text-sidebar-foreground">
          {props.repo.worktree}
        </span>
      </div>
      <div className="mt-2 grid grid-cols-[8px_14px_minmax(0,1fr)] items-center gap-1.5">
        <WorkingSpinner size="xs" reducedMotion={props.reducedMotion} />
        <span className="flex size-3.5 items-center justify-center text-sidebar-foreground/65">
          {props.repo.agentIcon}
        </span>
        <span className="truncate font-mono text-[11px] text-sidebar-foreground/65">
          {props.repo.prompt}
        </span>
      </div>
    </div>
  )
}

function VisualTitlebar(props: { title: string }): JSX.Element {
  return (
    <div className="flex h-6 items-center gap-1.5 border-b border-border bg-muted/40 px-2">
      <span className="size-2 rounded-full bg-foreground/15" />
      <span className="size-2 rounded-full bg-foreground/15" />
      <span className="size-2 rounded-full bg-foreground/15" />
      <span className="ml-1 truncate font-mono text-[11px] text-muted-foreground">
        {props.title}
      </span>
    </div>
  )
}

function TerminalLine(props: { children: ReactNode; muted?: boolean }): JSX.Element {
  return (
    <div
      className={cn(
        'flex min-w-0 items-center gap-1.5 truncate leading-[1.45]',
        props.muted ? 'text-muted-foreground' : 'text-foreground'
      )}
    >
      {props.children}
    </div>
  )
}

function Prompt(props: { children: ReactNode }): JSX.Element {
  return <span className="shrink-0 text-primary">{props.children}</span>
}

function useRepoFocus(reducedMotion: boolean): RepoFocus {
  const [idx, setIdx] = useState(() => (reducedMotion ? FOCUS_SEQUENCE.indexOf('both') : 0))

  useEffect(() => {
    if (reducedMotion) {
      setIdx(FOCUS_SEQUENCE.indexOf('both'))
      return
    }
    const id = window.setInterval(() => {
      setIdx((current) => (current + 1) % FOCUS_SEQUENCE.length)
    }, 1700)
    return () => window.clearInterval(id)
  }, [reducedMotion])

  return FOCUS_SEQUENCE[idx] ?? 'both'
}
