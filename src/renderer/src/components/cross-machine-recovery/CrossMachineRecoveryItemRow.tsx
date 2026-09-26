import { AlertCircle, PauseCircle } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import { CommandItem } from '@/components/ui/command'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { formatUiRelativeTime } from '@/i18n/relative-time-format'
import { notRestorableReasonLabel, pauseReasonLabel } from './cross-machine-recovery-copy'
import {
  workspaceDisabledReason,
  type RecoverySessionRow,
  type RecoveryWorkspaceRow
} from './cross-machine-recovery-rows'

function ageLabel(timestamp: number | null, now: number): string {
  return timestamp === null
    ? translate('components.cross-machine-recovery.row.ageUnknown', 'unknown time')
    : formatUiRelativeTime(timestamp - now)
}

export function notReadyReason(row: RecoveryWorkspaceRow): string | null {
  const disabled = workspaceDisabledReason(row)
  if (!disabled) {
    return null
  }
  return disabled.missing.length > 0
    ? translate(
        'components.cross-machine-recovery.row.notReadyMissing',
        'Not ready: missing {{missing}}',
        {
          missing: disabled.missing.join(', ')
        }
      )
    : translate('components.cross-machine-recovery.row.notReady', 'Not ready to recover yet')
}

export function CrossMachineRecoveryItemRow({
  row,
  hostName,
  now,
  onSelect
}: {
  row: RecoveryWorkspaceRow
  hostName: string
  now: number
  onSelect: (selector: string) => void
}): React.JSX.Element {
  const reason = notReadyReason(row)
  return (
    <CommandItem
      value={row.selector}
      keywords={[row.workspaceName, row.repoName, row.branch ?? '', hostName].concat(
        row.sessions.map((session) => session.title)
      )}
      disabled={reason !== null}
      onSelect={onSelect}
      data-testid="cross-machine-recovery-item"
      className="items-start"
    >
      <span className="min-w-0 flex-1 space-y-0.5">
        <span className="block truncate text-sm">{row.workspaceName}</span>
        <span className="block truncate text-xs text-muted-foreground">
          {[row.repoName, row.branch].filter(Boolean).join(' · ')} ·{' '}
          {translate('components.cross-machine-recovery.row.sessions', '{{count}} sessions', {
            count: row.sessions.length
          })}{' '}
          · {ageLabel(row.newestHumanActivityAt ?? row.checkpointCapturedAt, now)}
        </span>
        {row.completeness.code === 'deferred' ? (
          <span
            className="block truncate text-xs text-muted-foreground"
            data-testid="cross-machine-recovery-code-age"
          >
            {translate(
              'components.cross-machine-recovery.row.codeDeferred',
              'Code capture deferred · code from {{codeAge}}',
              {
                codeAge: ageLabel(
                  row.completeness.code_captured_at
                    ? Date.parse(row.completeness.code_captured_at)
                    : null,
                  now
                )
              }
            )}
          </span>
        ) : null}
        {row.newerPartial ? (
          <span
            className="block truncate text-xs text-muted-foreground"
            data-testid="cross-machine-recovery-newer-partial"
          >
            {translate(
              'components.cross-machine-recovery.row.newerPartial',
              'Newer partial checkpoint not recovered · sessions from {{sessionAge}} · code from {{codeAge}}',
              {
                sessionAge: ageLabel(row.newerPartial.sessionActivityAt, now),
                codeAge: ageLabel(row.newerPartial.codeCapturedAt, now)
              }
            )}
          </span>
        ) : null}
        {row.notRestorable.length > 0 ? (
          <span
            className="block text-xs text-muted-foreground"
            data-testid="cross-machine-recovery-not-restorable"
          >
            {translate(
              'components.cross-machine-recovery.row.notRestorable',
              "Can't recover here: {{sessions}}",
              {
                sessions: row.notRestorable
                  .map(
                    (session) =>
                      `${session.agent} ${session.id} (${notRestorableReasonLabel(session.reason)})`
                  )
                  .join(', ')
              }
            )}
          </span>
        ) : null}
        {reason ? (
          <span className="flex items-center gap-1 text-xs text-muted-foreground">
            <AlertCircle className="size-3" />
            {reason}
          </span>
        ) : null}
      </span>
      {row.pause ? (
        <Badge variant="outline">
          <PauseCircle className="size-3" />
          {pauseReasonLabel(row.pause)}
        </Badge>
      ) : null}
      {row.completeness.transcript === 'partial' ? (
        <Badge variant="secondary">
          {translate('components.cross-machine-recovery.row.partial', 'Partial transcript')}
        </Badge>
      ) : null}
    </CommandItem>
  )
}

export function CrossMachineRecoverySessionRow({
  session,
  checked,
  now,
  onCheckedChange
}: {
  session: RecoverySessionRow
  checked: boolean
  now: number
  onCheckedChange: (sessionId: string, checked: boolean) => void
}): React.JSX.Element {
  const checkbox = (
    <label className="flex items-start gap-2.5 py-1" data-testid="cross-machine-recovery-session">
      <Checkbox
        className="mt-0.5"
        checked={checked}
        disabled={session.liveLocalCollision}
        onCheckedChange={(value) => onCheckedChange(session.sessionId, value === true)}
        aria-label={session.title || session.sessionId}
      />
      <span className="min-w-0 space-y-0.5">
        <span className="block truncate text-sm">{session.title || session.sessionId}</span>
        <span className="block text-xs text-muted-foreground">
          {session.liveLocalCollision
            ? translate(
                'components.cross-machine-recovery.row.collision',
                'Already running on this computer'
              )
            : checked
              ? translate(
                  'components.cross-machine-recovery.row.resumeAge',
                  'Resume · last used {{age}}',
                  {
                    age: ageLabel(session.lastHumanActivityAt ?? session.lastActivityAt, now)
                  }
                )
              : translate(
                  'components.cross-machine-recovery.row.dormantAge',
                  'Restore without starting · last used {{age}}',
                  {
                    age: ageLabel(session.lastHumanActivityAt ?? session.lastActivityAt, now)
                  }
                )}
        </span>
      </span>
    </label>
  )
  if (!session.liveLocalCollision) {
    return checkbox
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>{checkbox}</TooltipTrigger>
      <TooltipContent side="top" sideOffset={6}>
        {translate(
          'components.cross-machine-recovery.row.collisionTooltip',
          'This session is live here; resuming it again would fork the conversation.'
        )}
      </TooltipContent>
    </Tooltip>
  )
}
