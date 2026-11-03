import {
  CircleCheck,
  CircleDashed,
  CircleDot,
  CircleX,
  Contrast,
  type LucideIcon
} from 'lucide-react'
import { translate } from '@/i18n/i18n'
import type { IssueInfo } from '../../../../shared/github/pull-request-types'

export type WorktreeTaskState = {
  Icon: LucideIcon
  tone: string
  label: string
}

type TaskStateKind = 'open' | 'backlog' | 'active' | 'done' | 'cancelled'

const TONES: Record<TaskStateKind, string> = {
  open: 'text-emerald-500/80',
  backlog: 'text-muted-foreground/60',
  active: 'text-amber-500/85',
  done: 'text-purple-600/70 dark:text-purple-400/70',
  cancelled: 'text-muted-foreground/60'
}

const ICONS: Record<TaskStateKind, LucideIcon> = {
  open: CircleDot,
  backlog: CircleDashed,
  active: Contrast,
  done: CircleCheck,
  cancelled: CircleX
}

function stateLabel(value: string): string {
  return translate(
    'auto.components.sidebar.WorktreeCardMetadataStatusBadges.af2b07bda5',
    'State: {{value0}}',
    {
      value0: value
    }
  )
}

function classifyLinearState(stateName: string, stateType?: string): TaskStateKind {
  if (stateType) {
    return stateType === 'completed'
      ? 'done'
      : stateType === 'canceled'
        ? 'cancelled'
        : stateType === 'started'
          ? 'active'
          : stateType === 'backlog' || stateType === 'triage'
            ? 'backlog'
            : 'open'
  }
  const name = stateName.toLowerCase()
  return /done|closed|complete|merged|resolved/.test(name)
    ? 'done'
    : /cancel|duplicate|wontfix/.test(name)
      ? 'cancelled'
      : /progress|doing|started|active|review/.test(name)
        ? 'active'
        : /backlog|triage/.test(name)
          ? 'backlog'
          : 'open'
}

function present(kind: TaskStateKind, label: string): WorktreeTaskState {
  return { Icon: ICONS[kind], tone: TONES[kind], label }
}

export function getIssueTaskState(state: IssueInfo['state'] | undefined): WorktreeTaskState | null {
  if (state === 'closed') {
    return present(
      'done',
      translate(
        'auto.components.sidebar.WorktreeCardMetadataStatusBadges.e888362def',
        'State: Closed'
      )
    )
  }
  if (state === 'open') {
    return present(
      'open',
      translate(
        'auto.components.sidebar.WorktreeCardMetadataStatusBadges.fe188062a1',
        'State: Open'
      )
    )
  }
  return null
}

export function getLinearTaskState(
  stateName: string | undefined,
  stateType?: string
): WorktreeTaskState | null {
  return stateName
    ? present(classifyLinearState(stateName, stateType), stateLabel(stateName))
    : null
}
