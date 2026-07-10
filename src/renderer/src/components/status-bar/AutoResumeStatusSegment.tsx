import React from 'react'
import { Hourglass } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '../../store'

// i18n keys held as constants (not inline literals) to match the settings-copy
// pattern and the catalog verifier, which only statically checks literal keys.
const WAITING_KEY = 'auto.components.status-bar.auto-resume.waiting'
const RESUMES_KEY = 'auto.components.status-bar.auto-resume.resumes'
const AGENT_KEY = 'auto.components.status-bar.auto-resume.agent'
const AGENTS_KEY = 'auto.components.status-bar.auto-resume.agents'
const LABEL_KEY = 'auto.components.status-bar.auto-resume.label'
const TOOLTIP_KEY = 'auto.components.status-bar.auto-resume.tooltip'

function formatResumeClock(resumesAt: number | null): string {
  if (typeof resumesAt !== 'number' || !Number.isFinite(resumesAt)) {
    return translate(WAITING_KEY, 'waiting for reset')
  }
  try {
    const time = new Date(resumesAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    return translate(RESUMES_KEY, 'resumes {{time}}', { time })
  } catch {
    return translate(WAITING_KEY, 'waiting for reset')
  }
}

/**
 * Compact status-bar segment shown while ≥1 agent is paused on a usage limit.
 * Reads the auto-resume store snapshot pushed from the main-process service.
 * Clicking focuses the soonest-resuming worktree.
 */
export function AutoResumeStatusSegment({
  iconOnly
}: {
  compact: boolean
  iconOnly: boolean
}): React.JSX.Element | null {
  const summary = useAppStore(
    useShallow((s) => {
      let count = 0
      let soonestAt: number | null = null
      let targetWorktreeId: string | null = null
      for (const entry of s.autoResumeEntries) {
        count += 1
        if (
          typeof entry.resumesAt === 'number' &&
          (soonestAt === null || entry.resumesAt < soonestAt)
        ) {
          soonestAt = entry.resumesAt
          targetWorktreeId = entry.worktreeId
        }
        if (targetWorktreeId === null) {
          targetWorktreeId = entry.worktreeId
        }
      }
      return { count, soonestAt, targetWorktreeId }
    })
  )
  const setActiveWorktree = useAppStore((s) => s.setActiveWorktree)

  if (summary.count === 0) {
    return null
  }

  const noun = summary.count === 1 ? translate(AGENT_KEY, 'agent') : translate(AGENTS_KEY, 'agents')
  const label = translate(LABEL_KEY, '{{n}} paused', { n: summary.count })
  const tooltip = translate(TOOLTIP_KEY, '{{n}} {{noun}} paused · {{detail}}', {
    n: summary.count,
    noun,
    detail: formatResumeClock(summary.soonestAt)
  })

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={() => {
            if (summary.targetWorktreeId) {
              setActiveWorktree(summary.targetWorktreeId)
            }
          }}
          className="inline-flex items-center gap-1.5 cursor-pointer rounded px-1 py-0.5 hover:bg-accent/70"
          aria-label={tooltip}
        >
          <Hourglass className="size-3 text-amber-500" />
          {!iconOnly && <span className="text-[11px] tabular-nums">{label}</span>}
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={6}>
        {tooltip}
      </TooltipContent>
    </Tooltip>
  )
}
