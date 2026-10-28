import React from 'react'
import { Minus, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { translate } from '@/i18n/i18n'
import { basename, dirname } from '@/lib/path'
import type { GitStatusEntry } from '../../../../../../shared/git-status-types'
import {
  canStageStatusEntry,
  canUnstageStatusEntry
} from '../../../../../../shared/source-control-entry-actions'
import { STATUS_COLORS, STATUS_LABELS } from '../../status-display'
import { ActionButton } from './action-button'
import type { SubmoduleChangesState } from './use-submodule-changes'

function ChangeRow({
  entry,
  disabled,
  onAction
}: {
  entry: GitStatusEntry
  disabled: boolean
  onAction: () => void
}): React.JSX.Element {
  const staged = entry.area === 'staged'
  const name = basename(entry.path)
  const dir = dirname(entry.path)
  const title = staged
    ? translate(
        'auto.components.right.sidebar.SourceControl.submoduleUnstage',
        'Unstage {{value0}}',
        {
          value0: name
        }
      )
    : translate('auto.components.right.sidebar.SourceControl.submoduleStage', 'Stage {{value0}}', {
        value0: name
      })
  const allowed = staged ? canUnstageStatusEntry(entry) : canStageStatusEntry(entry)
  return (
    <div className="flex items-center gap-1 py-0.5 pl-10 pr-3" data-testid="submodule-change-row">
      <span className="min-w-0 flex-1 truncate text-xs" title={entry.path}>
        {name}
        {dir && dir !== '.' ? (
          <span className="ml-1 text-[11px] text-muted-foreground">{dir}</span>
        ) : null}
      </span>
      <span
        className="w-4 shrink-0 text-center text-[11px] font-semibold"
        style={{ color: STATUS_COLORS[entry.status] }}
      >
        {STATUS_LABELS[entry.status]}
      </span>
      <ActionButton
        icon={staged ? Minus : Plus}
        title={title}
        disabled={disabled || !allowed}
        onClick={onAction}
      />
    </div>
  )
}

function ChangeGroup({
  label,
  entries,
  allLabel,
  disabled,
  onAll,
  onOne
}: {
  label: string
  entries: GitStatusEntry[]
  allLabel: string
  disabled: boolean
  onAll: () => void
  onOne: (entry: GitStatusEntry) => void
}): React.JSX.Element | null {
  if (entries.length === 0) {
    return null
  }
  return (
    <div>
      <div className="flex items-center gap-1 py-0.5 pl-8 pr-3 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        <span className="flex-1">
          {label} <span className="tabular-nums">{entries.length}</span>
        </span>
        <Button type="button" variant="ghost" size="xs" disabled={disabled} onClick={onAll}>
          {allLabel}
        </Button>
      </div>
      {entries.map((entry) => (
        <ChangeRow
          key={`${entry.area}:${entry.path}`}
          entry={entry}
          disabled={disabled}
          onAction={() => onOne(entry)}
        />
      ))}
    </div>
  )
}

/** One submodule's own changes with stage, unstage and its own commit box. */
export function SubmoduleChangesPanel({
  state,
  message,
  busy,
  onStage,
  onUnstage,
  onMessage,
  onCommit
}: {
  state: SubmoduleChangesState | undefined
  message: string
  busy: boolean
  onStage: (filePaths: string[]) => void
  onUnstage: (filePaths: string[]) => void
  onMessage: (message: string) => void
  onCommit: () => void
}): React.JSX.Element {
  if (!state || state.status === 'loading') {
    return (
      <div className="py-1 pl-10 pr-3 text-[11px] text-muted-foreground">
        {translate(
          'auto.components.right.sidebar.SourceControl.submoduleChangesLoading',
          'Loading changes…'
        )}
      </div>
    )
  }
  if (state.status === 'error') {
    return <div className="py-1 pl-10 pr-3 text-[11px] text-destructive">{state.message}</div>
  }
  const staged = state.entries.filter((entry) => entry.area === 'staged')
  const unstaged = state.entries.filter((entry) => entry.area !== 'staged')
  if (staged.length === 0 && unstaged.length === 0) {
    return (
      <div className="py-1 pl-10 pr-3 text-[11px] text-muted-foreground">
        {translate('auto.components.right.sidebar.SourceControl.submoduleNoChanges', 'No changes')}
      </div>
    )
  }
  return (
    <div className="pb-1">
      <ChangeGroup
        label={translate('auto.components.right.sidebar.SourceControl.submoduleStaged', 'Staged')}
        entries={staged}
        allLabel={translate(
          'auto.components.right.sidebar.SourceControl.submoduleUnstageAll',
          'Unstage all'
        )}
        disabled={busy}
        onAll={() => onUnstage(staged.filter(canUnstageStatusEntry).map((entry) => entry.path))}
        onOne={(entry) => onUnstage([entry.path])}
      />
      <ChangeGroup
        label={translate('auto.components.right.sidebar.SourceControl.submoduleChanges', 'Changes')}
        entries={unstaged}
        allLabel={translate(
          'auto.components.right.sidebar.SourceControl.submoduleStageAll',
          'Stage all'
        )}
        disabled={busy}
        onAll={() => onStage(unstaged.filter(canStageStatusEntry).map((entry) => entry.path))}
        onOne={(entry) => onStage([entry.path])}
      />
      <div className="flex flex-col gap-1 py-1 pl-8 pr-3">
        <Textarea
          rows={2}
          value={message}
          disabled={busy}
          placeholder={translate(
            'auto.components.right.sidebar.SourceControl.submoduleMessage',
            'Message'
          )}
          aria-label={translate(
            'auto.components.right.sidebar.SourceControl.submoduleMessage',
            'Message'
          )}
          className="min-h-0 resize-none"
          onChange={(event) => onMessage(event.target.value)}
        />
        <Button
          type="button"
          size="xs"
          disabled={busy || staged.length === 0 || message.trim().length === 0}
          onClick={onCommit}
        >
          {translate('auto.components.right.sidebar.SourceControl.submoduleCommit', 'Commit')}
        </Button>
      </div>
    </div>
  )
}
