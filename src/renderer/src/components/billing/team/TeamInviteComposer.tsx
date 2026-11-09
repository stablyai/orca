import { useId, useRef, useState } from 'react'
import { CircleAlert, Send, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { LoadingSpinner } from '@/components/LoadingSpinner'
import { SettingsDisabledControlTooltip } from '@/components/settings/form-controls/SettingsDisabledControlTooltip'
import { useIntlLocale, useTranslate, type Translate } from '@/i18n/use-translate'
import { cn } from '@/lib/utils'
import type { OrcaBillingEntitlement } from '../../../../../shared/orca-billing'
import type { OrcaOrgRole } from '../../../../../shared/orca-profiles'
import { formatCents } from '../plans/plans-pricing'
import {
  MAX_INVITES_PER_BATCH,
  mergeInviteCandidates,
  splitInviteText,
  type InviteCandidate
} from './parse-invite-emails'
import { roleDescription } from './team-copy'
import { assignableRoles, roleLabel } from './team-roles'
import { inviteSeatImpact, type InviteSeatImpact } from './team-seat-math'

export type InviteBatchOutcome = { failed: { email: string; message: string }[] }

export type TeamInviteComposerProps = {
  viewerRole: OrcaOrgRole
  entitlement: OrcaBillingEntitlement | null
  members: number
  pendingInvites: number
  now: number
  /** Sends every invite; resolves with the ones that failed so they stay in the field. */
  onInvite: (emails: string[], role: OrcaOrgRole) => Promise<InviteBatchOutcome>
  inputRef?: React.Ref<HTMLInputElement>
}

function impactCopy(
  impact: InviteSeatImpact,
  candidates: InviteCandidate[],
  locale: string,
  t: Translate
): string {
  const count = candidates.length
  if (count === 0) {
    return t(
      'auto.components.billing.team.inviteHint',
      'Paste a list: commas, spaces and new lines all work. Invites don’t take a seat until accepted.'
    )
  }
  switch (impact.kind) {
    case 'no-plan':
      return t(
        'auto.components.billing.team.inviteNoPlan',
        'Invites are free. Seats are billed once your team picks a plan.'
      )
    case 'covered':
      return count === 1
        ? t(
            'auto.components.billing.team.inviteCoveredOne',
            'Covered: uses a seat you already paid for this period.'
          )
        : t(
            'auto.components.billing.team.inviteCoveredMany',
            'Covered: these use seats you already paid for this period.'
          )
    case 'adds-seats-unpriced':
      return t(
        'auto.components.billing.team.inviteAddsUnpriced',
        'Each accepted invite above your paid seats adds a seat, charged now and prorated.'
      )
    case 'adds-seats': {
      const prorated = formatCents(impact.proratedCentsEach, locale)
      const price = formatCents(impact.perSeatPeriodCents, locale)
      const then =
        impact.interval === 'year'
          ? t('auto.components.billing.team.perYear', '{{value0}}/year', { value0: price })
          : t('auto.components.billing.team.perMonth', '{{value0}}/month', { value0: price })
      if (count === 1) {
        const first = candidates[0]!.email.split('@')[0] ?? candidates[0]!.email
        return t(
          'auto.components.billing.team.inviteAddsOne2',
          'When {{value0}} accepts, they add a seat: about {{value1}} prorated, then {{value2}}.',
          { value0: first, value1: prorated, value2: then }
        )
      }
      const covered =
        impact.coveredSeats > 0
          ? ` ${t(
              'auto.components.billing.team.inviteCoveredPart',
              'The first {{value0}} use seats already paid.',
              { value0: String(impact.coveredSeats) }
            )}`
          : ''
      return (
        t(
          'auto.components.billing.team.inviteAddsMany3',
          '{{value0}} of these add a seat each when accepted: about {{value1}} each now (prorated), then {{value2}} each.',
          { value0: String(impact.addedSeats), value1: prorated, value2: then }
        ) + covered
      )
    }
  }
}

/** Multi-email invite field: paste a list, review the chips, pick a role, send. */
export function TeamInviteComposer(props: TeamInviteComposerProps): React.JSX.Element {
  const t = useTranslate()
  const locale = useIntlLocale()
  const id = useId()
  const [draft, setDraft] = useState('')
  const [candidates, setCandidates] = useState<InviteCandidate[]>([])
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [role, setRole] = useState<OrcaOrgRole>('member')
  const [sending, setSending] = useState(false)
  const localInput = useRef<HTMLInputElement | null>(null)
  const roles = assignableRoles(props.viewerRole)

  const commit = (text: string): InviteCandidate[] => {
    const next = mergeInviteCandidates(candidates, splitInviteText(text))
    setCandidates(next)
    setDraft('')
    return next
  }
  const remove = (email: string): void => {
    setCandidates((list) => list.filter((candidate) => candidate.email !== email))
    setErrors(({ [email]: _removed, ...rest }) => rest)
  }

  const pendingDraft = draft.trim()
    ? mergeInviteCandidates(candidates, splitInviteText(draft))
    : candidates
  // The button counts what Send would send (including a typed, unseparated address); the hint
  // describes committed chips only, so it doesn't change on every keystroke.
  const valid = pendingDraft.filter((candidate) => candidate.valid)
  const committedValid = candidates.filter((candidate) => candidate.valid)
  const invalidCount = candidates.length - committedValid.length
  const paymentFailed = props.entitlement?.payment.pastDueSince != null
  const impact = inviteSeatImpact({
    entitlement: props.entitlement,
    members: props.members,
    pendingInvites: props.pendingInvites,
    newInvites: committedValid.length,
    now: props.now
  })

  const send = async (): Promise<void> => {
    const all = commit(draft)
    const emails = all.filter((candidate) => candidate.valid).map((candidate) => candidate.email)
    if (emails.length === 0 || sending) {
      return
    }
    setSending(true)
    const outcome = await props.onInvite(emails, role)
    setSending(false)
    const failed = new Map(outcome.failed.map((entry) => [entry.email, entry.message]))
    // Sent ones leave; failures and invalid entries stay so nothing typed is lost (review M12).
    setCandidates((list) =>
      list.filter((candidate) => !candidate.valid || failed.has(candidate.email))
    )
    setErrors(Object.fromEntries(failed))
  }

  const hintId = `${id}-hint`
  const describedErrors = Object.entries(errors)

  return (
    <form
      className="space-y-2"
      onSubmit={(event) => {
        event.preventDefault()
        void send()
      }}
    >
      <label htmlFor={`${id}-input`} className="text-sm font-medium">
        {t('auto.components.billing.team.inviteLabel', 'Invite teammates')}
      </label>
      <div className="flex flex-wrap items-start gap-2">
        <div
          className={cn(
            'flex min-h-8 min-w-[16rem] flex-1 cursor-text flex-wrap items-center gap-1 rounded-md border border-input bg-transparent px-2 py-0.5 shadow-xs transition-[color,box-shadow] dark:bg-input/30',
            'focus-within:border-ring focus-within:ring-2 focus-within:ring-focus-ring'
          )}
          onClick={() => localInput.current?.focus()}
        >
          {candidates.map((candidate) => {
            const error = errors[candidate.email]
            const bad = !candidate.valid || Boolean(error)
            return (
              <span
                key={candidate.email}
                className={cn(
                  'inline-flex max-w-full items-center gap-1 rounded-full border py-0.5 pr-0.5 pl-2 text-xs animate-in fade-in-0 zoom-in-95 duration-150 motion-reduce:animate-none',
                  bad
                    ? 'border-destructive bg-destructive/10 text-foreground'
                    : 'border-border bg-secondary text-secondary-foreground'
                )}
                title={
                  error ??
                  (candidate.valid
                    ? undefined
                    : t('auto.components.billing.team.notAnEmail', 'Not an email address'))
                }
              >
                {bad ? (
                  <CircleAlert aria-hidden className="size-3 shrink-0 text-destructive" />
                ) : null}
                <span className="truncate">{candidate.email}</span>
                {bad ? (
                  <span className="sr-only">
                    {error ?? t('auto.components.billing.team.notAnEmail', 'Not an email address')}
                  </span>
                ) : null}
                <button
                  type="button"
                  className="-my-1 -mr-1 flex size-6 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-foreground/10 hover:text-foreground focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:outline-none"
                  aria-label={t('auto.components.billing.team.removeChip', 'Remove {{value0}}', {
                    value0: candidate.email
                  })}
                  onClick={(event) => {
                    event.stopPropagation()
                    remove(candidate.email)
                  }}
                >
                  <X className="size-3" />
                </button>
              </span>
            )
          })}
          <input
            id={`${id}-input`}
            ref={(node) => {
              localInput.current = node
              if (typeof props.inputRef === 'function') {
                props.inputRef(node)
              } else if (props.inputRef) {
                props.inputRef.current = node
              }
            }}
            type="text"
            inputMode="email"
            autoComplete="off"
            spellCheck={false}
            aria-describedby={hintId}
            aria-invalid={invalidCount > 0 || undefined}
            readOnly={sending || candidates.length >= MAX_INVITES_PER_BATCH}
            aria-disabled={sending || undefined}
            placeholder={
              candidates.length === 0
                ? t(
                    'auto.components.billing.team.invitePlaceholder2',
                    'alex@company.com, sam@company.com'
                  )
                : undefined
            }
            className="h-6 min-w-[10rem] flex-1 bg-transparent px-1 text-sm outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed"
            value={draft}
            onChange={(event) => {
              const value = event.target.value
              // A separator ends the current address.
              if (/[\s,;]$/.test(value)) {
                commit(value)
              } else {
                setDraft(value)
              }
            }}
            onPaste={(event) => {
              const text = event.clipboardData.getData('text')
              if (/[\s,;<]/.test(text)) {
                event.preventDefault()
                commit(`${draft}${text}`)
              }
            }}
            onKeyDown={(event) => {
              if (event.key === 'Backspace' && draft === '' && candidates.length > 0 && !sending) {
                remove(candidates.at(-1)!.email)
              }
            }}
            onBlur={() => {
              if (draft.trim()) {
                commit(draft)
              }
            }}
          />
        </div>
        <div className="flex shrink-0 gap-2">
          <Select
            value={role}
            disabled={sending}
            onValueChange={(next) => {
              const picked = roles.find((candidate) => candidate === next)
              if (picked) {
                setRole(picked)
              }
            }}
          >
            <SelectTrigger
              size="sm"
              className="w-28"
              aria-label={t('auto.components.billing.team.inviteRole', 'Role for the invite')}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent align="end">
              {roles.map((option) => (
                <SelectItem key={option} value={option} title={roleDescription(option, t)}>
                  {roleLabel(option, t)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <SettingsDisabledControlTooltip
            reason={
              !sending && valid.length === 0
                ? t('auto.components.billing.team.enterEmail', 'Enter a teammate’s email')
                : undefined
            }
          >
            <Button
              type="submit"
              size="sm"
              // aria-disabled keeps focus here while sending; submit ignores it meanwhile.
              disabled={!sending && valid.length === 0}
              aria-disabled={sending || undefined}
            >
              {sending ? <LoadingSpinner className="size-3.5" /> : <Send />}
              {valid.length === 0
                ? // Nothing to count yet: a plain verb, not "Send 1 invite".
                  t('auto.components.billing.team.send', 'Send invite')
                : t('auto.components.billing.team.sendInvites', 'Send {{count}} invites', {
                    count: valid.length,
                    defaultValue_one: 'Send {{count}} invite'
                  })}
            </Button>
          </SettingsDisabledControlTooltip>
        </div>
      </div>
      <p id={hintId} className="text-xs text-muted-foreground text-pretty">
        {impactCopy(impact, committedValid, locale, t)}
        {paymentFailed && committedValid.length > 0
          ? ` ${t(
              'auto.components.billing.team.invitePaymentFailed2',
              'New seats are charged once the failed payment is fixed.'
            )}`
          : null}
        {invalidCount > 0
          ? ` ${t(
              'auto.components.billing.team.skipInvalid',
              'Skipping {{count}} invalid entries.',
              {
                count: invalidCount,
                defaultValue_one: 'Skipping {{count}} invalid entry.'
              }
            )}`
          : null}
      </p>
      {describedErrors.length > 0 ? (
        <ul role="alert" className="space-y-0.5 text-xs text-destructive">
          {describedErrors.map(([email, message]) => (
            <li key={email}>
              {email}: {message}
            </li>
          ))}
        </ul>
      ) : null}
    </form>
  )
}
