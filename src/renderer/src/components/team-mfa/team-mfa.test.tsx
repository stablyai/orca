// @vitest-environment happy-dom
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { translate } from '@/i18n/i18n'
import type { OrcaTeamMfaPolicy } from '../../../../shared/orca-team-mfa-policy'
import { RequireMfaRow, type RequireMfaRowProps } from './RequireMfaRow'
import { TeamMfaBanner } from './TeamMfaBanner'
import { TeamMfaBlockedScreen } from './TeamMfaBlockedScreen'
import { mfaCountdownLabel, mfaDaysLeft, teamMfaSurface } from './team-mfa-copy'
import { describeError, describeInlineError } from '../cloud-workspaces/cloud-workspace-errors'

afterEach(cleanup)

const DAY = 86_400_000
const NOW = Date.UTC(2026, 10, 18, 15)
const setupUrl = 'https://cloud.orca.dev/v1/account/security'

const policy = (over: Partial<OrcaTeamMfaPolicy> = {}): OrcaTeamMfaPolicy => ({
  policy: { enforceAt: NOW + 6 * DAY, setAt: NOW - DAY },
  self: 'pending',
  setupUrl,
  ...over
})

describe('countdown', () => {
  it('rounds up to whole days and stops at zero', () => {
    expect(mfaDaysLeft(NOW + 7 * DAY, NOW)).toBe(7)
    expect(mfaDaysLeft(NOW + 6 * DAY + 1, NOW)).toBe(7)
    expect(mfaDaysLeft(NOW + DAY / 2, NOW)).toBe(1)
    expect(mfaDaysLeft(NOW, NOW)).toBe(0)
    expect(mfaDaysLeft(NOW - DAY, NOW)).toBe(0)
  })

  it('reads as days left, one day left, then due now', () => {
    expect(mfaCountdownLabel(NOW + 6 * DAY, NOW, translate)).toBe('6 days left')
    expect(mfaCountdownLabel(NOW + DAY, NOW, translate)).toBe('1 day left')
    expect(mfaCountdownLabel(NOW, NOW, translate)).toBe('Due now')
  })
})

describe('what the member sees', () => {
  it('is the banner while pending and the blocked screen only on the server’s word', () => {
    expect(teamMfaSurface(policy())).toBe('banner')
    expect(teamMfaSurface(policy({ self: 'blocked' }))).toBe('blocked')
    // Past the deadline by the local clock, but the server still says pending: not blocked.
    expect(
      teamMfaSurface(policy({ policy: { enforceAt: NOW - DAY, setAt: NOW - 8 * DAY } }))
    ).toBe('banner')
  })

  it('is nothing with MFA on, an unknown state, or no policy', () => {
    expect(teamMfaSurface(policy({ self: 'on' }))).toBe('none')
    expect(teamMfaSurface(policy({ self: 'unknown' }))).toBe('none')
    expect(teamMfaSurface(policy({ policy: null, self: 'off' }))).toBe('none')
    expect(teamMfaSurface(policy({ policy: null, self: 'blocked' }))).toBe('none')
    expect(teamMfaSurface(null)).toBe('none')
  })
})

describe('banner', () => {
  it('names the team, the countdown and the date, and offers the setup action', () => {
    const onSetUp = vi.fn()
    const { container, getByRole } = render(
      <TeamMfaBanner
        teamName="Acme"
        enforceAt={NOW + 6 * DAY}
        now={NOW}
        setupUrl={setupUrl}
        onSetUp={onSetUp}
      />
    )
    expect(container.textContent).toContain('Acme requires two-factor authentication. 6 days left.')
    expect(container.textContent).toContain('November 24, 2026')
    fireEvent.click(getByRole('button', { name: 'Set up MFA' }))
    expect(onSetUp).toHaveBeenCalledTimes(1)
  })
})

describe('blocked screen', () => {
  const screen = (props: { checking?: boolean; stillMissing?: boolean } = {}) => {
    const handlers = { onSetUp: vi.fn(), onRecheck: vi.fn(), onUsePersonal: vi.fn() }
    const view = render(
      <TeamMfaBlockedScreen
        teamName="Acme"
        enforceAt={NOW - 2 * DAY}
        setupUrl={setupUrl}
        checking={props.checking === true}
        stillMissing={props.stillMissing === true}
        {...handlers}
      />
    )
    return { ...view, ...handlers }
  }

  it('says what to do, not a generic error, and keeps the personal account reachable', () => {
    const view = screen()
    expect(view.container.textContent).toContain('Set up two-factor authentication to use Acme')
    expect(view.container.textContent).toContain('Your workspaces and files are safe')
    fireEvent.click(view.getByRole('button', { name: 'Set up MFA' }))
    fireEvent.click(view.getByRole('button', { name: 'I’ve set it up' }))
    fireEvent.click(view.getByRole('button', { name: 'Use my personal account for now' }))
    expect(view.onSetUp).toHaveBeenCalledTimes(1)
    expect(view.onRecheck).toHaveBeenCalledTimes(1)
    expect(view.onUsePersonal).toHaveBeenCalledTimes(1)
  })

  it('ignores a second re-check while one runs, and says when MFA is still missing', () => {
    const checking = screen({ checking: true })
    fireEvent.click(checking.getByRole('button', { name: 'I’ve set it up' }))
    expect(checking.onRecheck).not.toHaveBeenCalled()
    cleanup()
    expect(screen({ stillMissing: true }).container.textContent).toContain(
      'Your account still has no two-factor authentication'
    )
  })
})

describe('Require MFA row', () => {
  const manage = { available: true, pendingMembers: 2 }
  const row = (props: Partial<RequireMfaRowProps> = {}) => {
    const handlers = {
      onRequire: vi.fn(),
      onTurnOff: vi.fn(),
      onRemind: vi.fn(),
      onSetUpOwn: vi.fn()
    }
    const view = render(
      <RequireMfaRow
        policy={policy({ policy: null, self: 'on', manage })}
        pending={null}
        now={NOW}
        busy={false}
        notice={null}
        {...handlers}
        {...props}
      />
    )
    return { ...view, ...handlers }
  }

  it('requires MFA with the chosen grace period, 14 days by default', () => {
    const view = row()
    fireEvent.click(view.getByRole('button', { name: 'Require MFA' }))
    expect(view.onRequire).toHaveBeenCalledWith(14)
  })

  it('holds the change back from an admin without MFA, and points them to setup', () => {
    const view = row({ policy: policy({ policy: null, self: 'off', manage }) })
    fireEvent.click(view.getByRole('button', { name: 'Require MFA' }))
    expect(view.onRequire).not.toHaveBeenCalled()
    expect(view.container.textContent).toContain(
      'Set up two-factor authentication on your own account first'
    )
    fireEvent.click(view.getByRole('button', { name: 'Set up MFA' }))
    expect(view.onSetUpOwn).toHaveBeenCalledTimes(1)
  })

  it('holds turning it off back from an admin without MFA too', () => {
    const view = row({ policy: policy({ self: 'pending', manage }) })
    fireEvent.click(view.getByRole('button', { name: 'Stop requiring' }))
    expect(view.onTurnOff).not.toHaveBeenCalled()
  })

  it('shows the date, who is pending, and reminds everyone or one member', () => {
    const view = row({
      policy: policy({ self: 'on', manage }),
      pending: [
        { userId: 'u-ada', email: 'ada@acme.dev', displayName: 'Ada Lovelace', mfa: 'pending' },
        { userId: null, email: 'linus@acme.dev', mfa: 'pending' }
      ]
    })
    expect(view.container.textContent).toContain('Required from November 24, 2026. 6 days left.')
    expect(view.container.textContent).toContain('2 members still need it')
    fireEvent.click(view.getByRole('button', { name: 'Remind everyone' }))
    expect(view.onRemind).toHaveBeenLastCalledWith()
    // A member who never signed in to Orca has no id to remind by; only Ada gets a button.
    const single = view.getAllByRole('button', { name: 'Remind' })
    expect(single).toHaveLength(1)
    fireEvent.click(single[0]!)
    expect(view.onRemind).toHaveBeenLastCalledWith('u-ada')
  })

  it('says members have no access once the deadline passed', () => {
    const view = row({
      policy: policy({
        self: 'on',
        manage,
        policy: { enforceAt: NOW - DAY, setAt: NOW - 8 * DAY }
      }),
      pending: [{ userId: 'u-ada', email: 'ada@acme.dev', mfa: 'blocked' }]
    })
    expect(view.container.textContent).toContain('Required since November 17, 2026')
    expect(view.container.textContent).toContain('No access')
  })

  it('says plainly when a reminder was recorded but not emailed', () => {
    const view = row({
      policy: policy({ self: 'on', manage }),
      notice: { kind: 'reminded', recipients: 2, emailed: false }
    })
    expect(view.container.textContent).toContain('nothing was sent')
    expect(view.container.textContent).not.toContain('Reminder sent')
  })
})

describe('the server refusal in cloud workspace errors', () => {
  it('says to set up MFA, never to sign in again', () => {
    for (const describe of [describeError, describeInlineError]) {
      const message = describe('unauthorized', 'mfa_required', translate)
      expect(message).toContain('requires two-factor authentication')
      expect(message).not.toMatch(/sign in/i)
    }
    // Any other unauthorized answer is still the sign-in message.
    expect(describeInlineError('unauthorized', undefined, translate)).not.toContain('two-factor')
  })
})
