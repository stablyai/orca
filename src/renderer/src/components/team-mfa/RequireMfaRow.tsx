import { useState } from 'react'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { InlineError } from '@/components/ui/inline-error'
import { OpenExternalSplitButton } from '@/components/open-external/OpenExternalSplitButton'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { useIntlLocale, useTranslate } from '@/i18n/use-translate'
import {
  ORCA_TEAM_MFA_GRACE_CHOICES,
  type OrcaTeamMfaGrace,
  type OrcaTeamMfaPendingMember,
  type OrcaTeamMfaPolicy
} from '../../../../shared/orca-team-mfa-policy'
import { mfaCountdownLabel, mfaDeadlineDate, mfaGraceLabel } from './team-mfa-copy'

export type RequireMfaRowNotice =
  | { kind: 'error'; message: string }
  /** `emailed` false: the server recorded the reminder but its email delivery is off. */
  | { kind: 'reminded'; recipients: number; emailed: boolean }

export type RequireMfaRowProps = {
  /** The policy read for an owner or admin (`manage` present). */
  policy: OrcaTeamMfaPolicy
  /** Null until the pending list is read; shown only while a policy is in force. */
  pending: OrcaTeamMfaPendingMember[] | null
  now: number
  busy: boolean
  notice: RequireMfaRowNotice | null
  onRequire: (grace: OrcaTeamMfaGrace) => void
  onTurnOff: () => void
  onRemind: (userId?: string) => void
  onSetUpOwn: () => void
}

/**
 * "Require two-factor" in Settings, Enterprise, Multi-factor authentication. Rendered only for a team
 * whose plan includes it; the pane shows its shared upsell otherwise.
 */
export function RequireMfaRow({
  policy,
  pending,
  now,
  busy,
  notice,
  onRequire,
  onTurnOff,
  onRemind,
  onSetUpOwn
}: RequireMfaRowProps): React.JSX.Element {
  const t = useTranslate()
  const locale = useIntlLocale()
  const [grace, setGrace] = useState<OrcaTeamMfaGrace>(14)
  const active = policy.policy
  const pendingCount = policy.manage?.pendingMembers ?? 0
  // The server refuses a change from someone without MFA; say so before they try.
  const needsOwnMfa = policy.self !== 'on' && policy.self !== 'delegated'
  const enforced = active !== null && active.enforceAt <= now

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start gap-4">
        <div className="min-w-0 flex-1 space-y-1">
          <p className="text-sm font-medium">
            {t('auto.components.teamMfa.rowTitle', 'Require two-factor authentication')}
          </p>
          <p className="text-xs leading-5 text-muted-foreground" aria-live="polite">
            {active === null
              ? t(
                  'auto.components.teamMfa.rowOff',
                  'Members without it lose access to this team’s workspaces after the date you pick, until they set it up. They get an email now and reminders before the date.'
                )
              : enforced
                ? t(
                    'auto.components.teamMfa.rowEnforced',
                    'Required since {{value0}}. Members without it can’t use this team until they set it up.',
                    { value0: mfaDeadlineDate(active.enforceAt, locale) }
                  )
                : t(
                    'auto.components.teamMfa.rowScheduled',
                    'Required from {{value0}}. {{value1}}.',
                    {
                      value0: mfaDeadlineDate(active.enforceAt, locale),
                      value1: mfaCountdownLabel(active.enforceAt, now, t)
                    }
                  )}
          </p>
        </div>
        {active === null ? (
          <div className="flex shrink-0 items-center gap-2">
            <Select
              value={String(grace)}
              onValueChange={(next) => {
                const choice = ORCA_TEAM_MFA_GRACE_CHOICES.find((c) => String(c) === next)
                if (choice !== undefined) {
                  setGrace(choice)
                }
              }}
            >
              <SelectTrigger
                size="sm"
                className="w-36"
                aria-label={t('auto.components.teamMfa.graceLabel', 'When to start requiring it')}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent align="end">
                {ORCA_TEAM_MFA_GRACE_CHOICES.map((choice) => (
                  <SelectItem key={String(choice)} value={String(choice)}>
                    {mfaGraceLabel(choice, t)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              type="button"
              size="sm"
              aria-disabled={busy || needsOwnMfa || undefined}
              onClick={() => {
                if (!busy && !needsOwnMfa) {
                  onRequire(grace)
                }
              }}
            >
              {busy ? <Loader2 className="size-4 animate-spin" /> : null}
              {t('auto.components.teamMfa.require', 'Require two-factor')}
            </Button>
          </div>
        ) : (
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-disabled={busy || needsOwnMfa || undefined}
            onClick={() => {
              if (!busy && !needsOwnMfa) {
                onTurnOff()
              }
            }}
          >
            {busy ? <Loader2 className="size-4 animate-spin" /> : null}
            {t('auto.components.teamMfa.turnOff', 'Stop requiring')}
          </Button>
        )}
      </div>

      {needsOwnMfa ? (
        <InlineError
          tone="neutral"
          title={t(
            'auto.components.teamMfa.ownMfaTitle',
            'Set up two-factor authentication on your own account first'
          )}
          detail={t(
            'auto.components.teamMfa.ownMfaBody',
            'Only someone who already has it can change this, so nobody locks the team out.'
          )}
          action={
            <OpenExternalSplitButton
              variant="outline"
              size="xs"
              link={policy.setupUrl}
              onClick={onSetUpOwn}
            >
              {t('auto.components.teamMfa.setUp', 'Set up two-factor')}
            </OpenExternalSplitButton>
          }
        />
      ) : null}

      {active === null && grace === 'now' && pendingCount > 0 && !needsOwnMfa ? (
        <p className="text-xs leading-5 text-muted-foreground">
          {t(
            'auto.components.teamMfa.nowWarning',
            '{{count}} members don’t have it yet and will lose access to this team right away.',
            {
              count: pendingCount,
              defaultValue_one:
                '{{count}} member doesn’t have it yet and will lose access to this team right away.'
            }
          )}
        </p>
      ) : null}

      {active !== null ? (
        <div className="space-y-2 border-t border-border/60 pt-4">
          <div className="flex flex-wrap items-center gap-3">
            <p className="min-w-0 flex-1 text-sm">
              {pendingCount === 0
                ? t('auto.components.teamMfa.allSet', 'Every member has it set up.')
                : t('auto.components.teamMfa.pendingCount', '{{count}} members still need it', {
                    count: pendingCount,
                    defaultValue_one: '{{count}} member still needs it'
                  })}
            </p>
            {pendingCount > 0 ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                aria-disabled={busy || undefined}
                onClick={() => {
                  if (!busy) {
                    onRemind()
                  }
                }}
              >
                {t('auto.components.teamMfa.remindAll', 'Remind everyone')}
              </Button>
            ) : null}
          </div>
          {pending && pending.length > 0 ? (
            <ul
              className="divide-y divide-border/60 overflow-hidden rounded-lg border border-border"
              aria-label={t(
                'auto.components.teamMfa.pendingList',
                'Members without two-factor authentication'
              )}
            >
              {pending.map((member) => (
                <li
                  key={member.userId ?? member.email}
                  className="flex min-h-10 items-center gap-3 bg-card px-3 py-1.5"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm">{member.displayName ?? member.email}</p>
                    {member.displayName ? (
                      <p className="truncate text-xs text-muted-foreground">{member.email}</p>
                    ) : null}
                  </div>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {member.mfa === 'blocked'
                      ? t('auto.components.teamMfa.memberBlocked', 'No access')
                      : t('auto.components.teamMfa.memberPending', 'Pending')}
                  </span>
                  {member.userId ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      aria-disabled={busy || undefined}
                      onClick={() => {
                        if (!busy && member.userId) {
                          onRemind(member.userId)
                        }
                      }}
                    >
                      {t('auto.components.teamMfa.remindOne', 'Remind')}
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {notice?.kind === 'error' ? <InlineError title={notice.message} /> : null}
      {notice?.kind === 'reminded' ? (
        <p className="text-xs text-muted-foreground" role="status">
          {notice.emailed
            ? t('auto.components.teamMfa.reminded', 'Reminder sent to {{count}} members.', {
                count: notice.recipients,
                defaultValue_one: 'Reminder sent to {{count}} member.'
              })
            : t(
                'auto.components.teamMfa.remindedNoEmail',
                'Reminder recorded, but email delivery is off on this server, so nothing was sent.'
              )}
        </p>
      ) : null}
    </div>
  )
}
