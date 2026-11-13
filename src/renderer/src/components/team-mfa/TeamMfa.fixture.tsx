import { defineFixture } from '../../component-fixtures/component-fixture'
import type {
  OrcaTeamMfaPendingMember,
  OrcaTeamMfaPolicy
} from '../../../../shared/orca-team-mfa-policy'
import { RequireMfaRow, type RequireMfaRowProps } from './RequireMfaRow'
import { TeamMfaBanner } from './TeamMfaBanner'
import { TeamMfaBlockedScreen } from './TeamMfaBlockedScreen'

const NOW = Date.UTC(2026, 10, 18, 15)
const DAY = 86_400_000
const setupUrl = 'https://cloud.orca.dev/v1/account/security'
const noop = (): void => {}
const width = 760

function frame(children: React.ReactNode, frameWidth = width) {
  return defineFixture({
    width: frameWidth,
    render: () => <div className="bg-background px-8 py-6">{children}</div>
  })
}

// ---- Banner: a member without MFA, before the deadline ----

const banner = (daysLeft: number, frameWidth = width) =>
  frame(
    <TeamMfaBanner
      teamName="Acme Engineering"
      enforceAt={NOW + daysLeft * DAY}
      now={NOW}
      setupUrl={setupUrl}
      onSetUp={noop}
    />,
    frameWidth
  )

export const bannerTwoWeeks = banner(14)
export const bannerOneDay = banner(1)
export const bannerNarrow = banner(6, 420)

// ---- Blocked screen: after the deadline ----

const blocked = (props: { checking?: boolean; stillMissing?: boolean; personal?: boolean }) =>
  frame(
    <TeamMfaBlockedScreen
      teamName="Acme Engineering"
      enforceAt={NOW - 2 * DAY}
      setupUrl={setupUrl}
      checking={props.checking === true}
      stillMissing={props.stillMissing === true}
      onSetUp={noop}
      onRecheck={noop}
      {...(props.personal === false ? {} : { onUsePersonal: noop })}
    />
  )

export const blockedScreen = blocked({})
export const blockedChecking = blocked({ checking: true })
/** "I've set it up" found no MFA yet. */
export const blockedStillMissing = blocked({ stillMissing: true })

// ---- Settings, Enterprise, Multi-factor authentication ----

const pendingMembers: OrcaTeamMfaPendingMember[] = [
  { userId: 'u-ada', email: 'ada@acme.dev', displayName: 'Ada Lovelace', mfa: 'pending' },
  { userId: 'u-grace', email: 'grace@acme.dev', displayName: 'Grace Hopper', mfa: 'pending' },
  { userId: null, email: 'linus@acme.dev', mfa: 'pending' }
]

const off: OrcaTeamMfaPolicy = {
  policy: null,
  self: 'on',
  setupUrl,
  manage: { available: true, pendingMembers: 3 }
}
const scheduled: OrcaTeamMfaPolicy = {
  ...off,
  policy: { enforceAt: NOW + 6 * DAY, setAt: NOW - 8 * DAY }
}

const row = (props: Partial<RequireMfaRowProps>) =>
  frame(
    <RequireMfaRow
      policy={off}
      pending={null}
      now={NOW}
      busy={false}
      notice={null}
      onRequire={noop}
      onTurnOff={noop}
      onRemind={noop}
      onSetUpOwn={noop}
      {...props}
    />
  )

/** Not required yet: pick when, then Require MFA. */
export const rowOff = row({})
/** The admin has no MFA themselves: the change is held back until they add it. */
export const rowAdminNeedsOwnMfa = row({ policy: { ...off, self: 'off' } })
/** Scheduled: the date, the countdown, who is pending, and Remind. */
export const rowScheduled = row({ policy: scheduled, pending: pendingMembers })
/** Past the deadline: pending members have no access. */
export const rowEnforced = row({
  policy: { ...off, policy: { enforceAt: NOW - 2 * DAY, setAt: NOW - 16 * DAY } },
  pending: pendingMembers.map((member) => ({ ...member, mfa: 'blocked' as const }))
})
export const rowEveryoneSet = row({
  policy: { ...scheduled, manage: { available: true, pendingMembers: 0 } },
  pending: []
})
export const rowSaving = row({ policy: scheduled, pending: pendingMembers, busy: true })
export const rowReminded = row({
  policy: scheduled,
  pending: pendingMembers,
  notice: { kind: 'reminded', recipients: 3, emailed: true }
})
/** The server is in log mode: say plainly that no email went out. */
export const rowRemindedNoEmail = row({
  policy: scheduled,
  pending: pendingMembers,
  notice: { kind: 'reminded', recipients: 3, emailed: false }
})
export const rowError = row({
  policy: scheduled,
  pending: pendingMembers,
  notice: { kind: 'error', message: 'Couldn’t save the change. Try again.' }
})
