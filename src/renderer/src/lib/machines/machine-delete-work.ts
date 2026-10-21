import type { GitUpstreamStatus } from '../../../../shared/git-status-types'
import {
  formatMachineWorkAtRisk,
  type MachineWorkAtRisk
} from '../../../../shared/machine-inventory'
import { translate } from '@/i18n/i18n'

/** What Orca could learn about one worktree's unsaved work before its machine is deleted. */
export type WorktreeWorkCheck = {
  /** Uncommitted files; `checking` while the host answers, `unknown` when it can't. */
  uncommitted: number | 'checking' | 'unknown'
  /** Commits ahead of upstream; `none` for a branch with nothing upstream to compare. */
  unpushed: number | 'checking' | 'unknown' | 'none'
}

/** A stopped machine's total from its Orca server: `null` when it couldn't be read (or fully). */
export type MachineWorkRead = MachineWorkAtRisk | null | 'checking'

/** Each row's line; a stopped machine's work is only known in total, so its rows share it. */
export function getWorktreeWorkCheck(
  running: boolean,
  stoppedWork: MachineWorkRead,
  uncommitted: readonly unknown[] | null | undefined,
  upstream: GitUpstreamStatus | null | undefined
): WorktreeWorkCheck | null {
  if (running) {
    return {
      uncommitted:
        uncommitted === undefined
          ? 'checking'
          : uncommitted === null
            ? 'unknown'
            : uncommitted.length,
      unpushed: toUnpushed(upstream)
    }
  }
  if (stoppedWork === 'checking') {
    return { uncommitted: 'checking', unpushed: 'checking' }
  }
  if (stoppedWork === null) {
    return { uncommitted: 'unknown', unpushed: 'unknown' }
  }
  // Why: a nonzero total can't be split by worktree, so the dialog states it once above the rows.
  return formatMachineWorkAtRisk(stoppedWork, translate) === null
    ? { uncommitted: 0, unpushed: 0 }
    : null
}

export function toUnpushed(
  status: GitUpstreamStatus | null | undefined
): WorktreeWorkCheck['unpushed'] {
  if (status === undefined) {
    return 'checking'
  }
  if (status === null) {
    return 'unknown'
  }
  return status.hasUpstream ? status.ahead : 'none'
}

function countPart(count: number, one: string, other: string): string {
  return count === 1 ? one : other
}

/**
 * One status line per worktree, as the Delete dialog shows it ("1 uncommitted · 2 unpushed").
 * Anything Orca couldn't read is said plainly; it is never shown as "No changes".
 */
export function describeWorktreeWork(work: WorktreeWorkCheck): {
  text: string
  atRisk: boolean
} {
  if (work.uncommitted === 'checking' || work.unpushed === 'checking') {
    return {
      text: translate('auto.lib.machines.machineDeleteWork.checking', 'Checking…'),
      atRisk: false
    }
  }
  if (work.uncommitted === 'unknown' && work.unpushed === 'unknown') {
    return {
      text: translate(
        'auto.lib.machines.machineDeleteWork.allUnknown',
        'Couldn’t check unsaved work'
      ),
      atRisk: true
    }
  }
  const parts: string[] = []
  if (work.uncommitted === 'unknown') {
    parts.push(
      translate(
        'auto.lib.machines.machineDeleteWork.uncommittedUnknown',
        'Couldn’t check uncommitted changes'
      )
    )
  } else if (work.uncommitted > 0) {
    parts.push(
      countPart(
        work.uncommitted,
        translate('auto.lib.machines.machineDeleteWork.uncommitted_one', '1 uncommitted'),
        translate(
          'auto.lib.machines.machineDeleteWork.uncommitted_other',
          '{{count}} uncommitted',
          {
            count: work.uncommitted
          }
        )
      )
    )
  }
  if (work.unpushed === 'unknown') {
    parts.push(
      translate(
        'auto.lib.machines.machineDeleteWork.unpushedUnknown',
        'Couldn’t check unpushed commits'
      )
    )
  } else if (work.unpushed === 'none') {
    parts.push(translate('auto.lib.machines.machineDeleteWork.noUpstream', 'Never pushed'))
  } else if (work.unpushed > 0) {
    parts.push(
      countPart(
        work.unpushed,
        translate('auto.lib.machines.machineDeleteWork.unpushed_one', '1 unpushed'),
        translate('auto.lib.machines.machineDeleteWork.unpushed_other', '{{count}} unpushed', {
          count: work.unpushed
        })
      )
    )
  }
  return parts.length > 0
    ? { text: parts.join(' · '), atRisk: true }
    : {
        text: translate('auto.lib.machines.machineDeleteWork.noChanges', 'No changes'),
        atRisk: false
      }
}
