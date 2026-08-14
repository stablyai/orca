import React from 'react'
import { FileDiff } from 'lucide-react'
import type { GitStatusEntry } from '../../../../shared/git-status-types'
import { translate } from '@/i18n/i18n'
import {
  WorktreeCardDetailSection,
  WorktreeCardDetailSectionContent
} from './WorktreeCardDetailSection'
import { summarizeWorktreeChanges } from './worktree-change-summary'
import { useAppStore } from '@/store'
import { useWorktreeChangeCountIsCapped } from './use-worktree-change-count'

function buildBreakdown(entries: readonly GitStatusEntry[]): string[] {
  const summary = summarizeWorktreeChanges(entries)
  const parts: string[] = []
  if (summary.staged > 0) {
    // Why a singular form for this one and not the others: "staged" translates to
    // an adjective that agrees with number, so es renders "1 preparados" without
    // it. "unstaged" and "untracked" resolve to invariant phrases.
    parts.push(
      summary.staged === 1
        ? translate('auto.components.sidebar.WorktreeCardChangeCountDetails.oneStaged', '1 staged')
        : translate(
            'auto.components.sidebar.WorktreeCardChangeCountDetails.staged',
            '{{value0}} staged',
            { value0: summary.staged }
          )
    )
  }
  if (summary.unstaged > 0) {
    parts.push(
      translate(
        'auto.components.sidebar.WorktreeCardChangeCountDetails.unstaged',
        '{{value0}} unstaged',
        { value0: summary.unstaged }
      )
    )
  }
  if (summary.untracked > 0) {
    parts.push(
      translate(
        'auto.components.sidebar.WorktreeCardChangeCountDetails.untracked',
        '{{value0}} untracked',
        { value0: summary.untracked }
      )
    )
  }
  if (summary.submodules > 0) {
    // Why: this is the line that answers "why does the count exceed my own file
    // edits?" — a dirty submodule is one change in the parent's working tree.
    parts.push(
      summary.submodules === 1
        ? translate(
            'auto.components.sidebar.WorktreeCardChangeCountDetails.oneSubmodule',
            '1 submodule'
          )
        : translate(
            'auto.components.sidebar.WorktreeCardChangeCountDetails.submodules',
            '{{value0}} submodules',
            { value0: summary.submodules }
          )
    )
  }
  return parts
}

/**
 * Explains the row's change count inside the card hover: the total, then what it
 * is made of. Renders nothing for a clean workspace, matching the row badge.
 */
export function WorktreeCardChangeCountDetails({
  worktreeId
}: {
  worktreeId: string
}): React.JSX.Element | null {
  const entries = useAppStore((s) => s.gitStatusByWorktree?.[worktreeId])
  const isCapped = useWorktreeChangeCountIsCapped(worktreeId)
  if (!entries || entries.length === 0) {
    return null
  }
  const breakdown = buildBreakdown(entries)

  return (
    <WorktreeCardDetailSection>
      <div className="flex items-center gap-1.5 px-1 text-[11px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
        <FileDiff className="size-3" />
        <span>
          {translate(
            'auto.components.sidebar.WorktreeCardChangeCountDetails.heading',
            'Uncommitted Changes'
          )}{' '}
          <span className="font-normal tabular-nums text-muted-foreground/70">
            ({isCapped ? `${entries.length}+` : entries.length})
          </span>
        </span>
      </div>
      <WorktreeCardDetailSectionContent>
        <p className="text-[11.5px] leading-snug text-muted-foreground">{breakdown.join(' · ')}</p>
        {isCapped ? (
          // Why: without this the breakdown reads as a complete account of a
          // truncated list, contradicting Source Control's own capped state.
          <p className="text-[11.5px] leading-snug text-muted-foreground/70">
            {translate(
              'auto.components.sidebar.WorktreeCardChangeCountDetails.cappedNotice',
              'Only the first {{value0}} changes are counted.',
              { value0: entries.length }
            )}
          </p>
        ) : null}
      </WorktreeCardDetailSectionContent>
    </WorktreeCardDetailSection>
  )
}
