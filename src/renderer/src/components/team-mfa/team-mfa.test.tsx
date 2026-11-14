// @vitest-environment happy-dom
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { translate } from '@/i18n/i18n'
import type { OrcaTeamMfaPolicy } from '../../../../shared/orca-team-mfa-policy'
import { TeamMfaBanner } from './TeamMfaBanner'
import { TeamMfaBlockedScreen } from './TeamMfaBlockedScreen'
import {
  claimMfaToast,
  mfaDaysLeft,
  mfaSoonTitle,
  mfaUrgency,
  teamMfaSurface
} from './team-mfa-copy'
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
})

describe('what the member sees', () => {
  it('is the banner while pending and the blocked screen only on the server’s word', () => {
    expect(teamMfaSurface(policy())).toBe('banner')
    expect(teamMfaSurface(policy({ self: 'blocked' }))).toBe('blocked')
    // Past the deadline by the local clock, but the server still says pending: not blocked.
    expect(teamMfaSurface(policy({ policy: { enforceAt: NOW - DAY, setAt: NOW - 8 * DAY } }))).toBe(
      'banner'
    )
  })

  it('is nothing with 2FA on, an unknown state, or no policy', () => {
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
    expect(container.textContent).toContain(
      'Acme requires two-factor authentication from November 24, 2026'
    )
    expect(container.textContent).toContain('November 24, 2026')
    fireEvent.click(getByRole('button', { name: 'Set up two-factor' }))
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
    fireEvent.click(view.getByRole('button', { name: 'Set up two-factor' }))
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

describe('the server refusal in cloud workspace errors', () => {
  it('says to set up MFA, never to sign in again', () => {
    for (const explain of [describeError, describeInlineError]) {
      const message = explain('unauthorized', 'mfa_required', translate)
      expect(message).toContain('requires two-factor authentication')
      expect(message).not.toMatch(/sign in/i)
    }
    // Any other unauthorized answer is still the sign-in message.
    expect(describeInlineError('unauthorized', undefined, translate)).not.toContain('two-factor')
  })
})

describe('banner after the deadline', () => {
  it('says there is no access until MFA is set up, and that the personal account is fine', () => {
    const { container, getByRole } = render(
      <TeamMfaBanner
        teamName="Acme"
        enforceAt={NOW - DAY}
        now={NOW}
        setupUrl={setupUrl}
        onSetUp={() => {}}
        blocked
        variant="sidebar"
      />
    )
    // An alert once blocked; a quiet status while there is still time.
    expect(container.querySelector('[data-team-mfa-banner="blocked"]')?.getAttribute('role')).toBe(
      'alert'
    )
    expect(container.textContent).toContain('Acme requires two-factor authentication')
    expect(container.textContent).toContain('until you set it up')
    expect(container.textContent).toContain('Your personal account isn’t affected')
    expect(container.textContent).not.toContain('days left')
    expect(getByRole('button', { name: 'Set up two-factor' })).toBeTruthy()
  })
})

describe('escalation', () => {
  it('is quiet with more than three days left, a warning in the last three, blocked on the server', () => {
    expect(mfaUrgency(NOW + 14 * DAY, NOW, false)).toBe('quiet')
    expect(mfaUrgency(NOW + 3 * DAY + 1, NOW, false)).toBe('quiet')
    expect(mfaUrgency(NOW + 3 * DAY, NOW, false)).toBe('soon')
    expect(mfaUrgency(NOW + DAY, NOW, false)).toBe('soon')
    // Past the deadline by the clock but not blocked by the server: still only a warning.
    expect(mfaUrgency(NOW - DAY, NOW, false)).toBe('soon')
    expect(mfaUrgency(NOW + 14 * DAY, NOW, true)).toBe('blocked')
  })

  it('names the days in the title once it is close', () => {
    expect(mfaSoonTitle('Acme', NOW + 2 * DAY, NOW, translate)).toBe(
      'Acme requires two-factor authentication in 2 days'
    )
    expect(mfaSoonTitle('Acme', NOW + DAY, NOW, translate)).toBe(
      'Acme requires two-factor authentication in 1 day'
    )
    expect(mfaSoonTitle('Acme', NOW - 1, NOW, translate)).toBe(
      'Acme requires two-factor authentication now'
    )
  })

  it('marks the sidebar card with its urgency', () => {
    const card = (daysLeft: number, blocked = false): string | null | undefined =>
      render(
        <TeamMfaBanner
          variant="sidebar"
          teamName="Acme"
          enforceAt={NOW + daysLeft * DAY}
          now={NOW}
          setupUrl={setupUrl}
          onSetUp={() => {}}
          blocked={blocked}
        />
      )
        .container.querySelector('[data-team-mfa-banner]')
        ?.getAttribute('data-team-mfa-banner')
    expect(card(14)).toBe('quiet')
    cleanup()
    expect(card(2)).toBe('soon')
    cleanup()
    expect(card(-2, true)).toBe('blocked')
  })
})

describe('one-time toast', () => {
  const memory = (): Pick<Storage, 'getItem' | 'setItem'> => {
    const map = new Map<string, string>()
    return {
      getItem: (key) => map.get(key) ?? null,
      setItem: (key, value) => void map.set(key, value)
    }
  }

  it('shows once per team and deadline, and again when the date changes', () => {
    const storage = memory()
    expect(claimMfaToast(storage, 'org_1', 100)).toBe(true)
    expect(claimMfaToast(storage, 'org_1', 100)).toBe(false)
    expect(claimMfaToast(storage, 'org_1', 200)).toBe(true)
    expect(claimMfaToast(storage, 'org_2', 100)).toBe(true)
  })

  it('shows rather than hides when storage is unavailable', () => {
    expect(claimMfaToast(null, 'org_1', 100)).toBe(true)
    const broken = {
      getItem: () => {
        throw new Error('denied')
      },
      setItem: () => {}
    }
    expect(claimMfaToast(broken, 'org_1', 100)).toBe(true)
  })
})

describe('single sign-on', () => {
  it('shows nothing to a member whose two-factor is handled by their identity provider', () => {
    expect(teamMfaSurface(policy({ self: 'delegated' }))).toBe('none')
  })
})

describe('design follow-ups', () => {
  const noop = (): void => {}
  it('underlines the personal-account link at rest', () => {
    const view = render(
      <TeamMfaBlockedScreen
        teamName="Acme"
        enforceAt={NOW - DAY}
        setupUrl={setupUrl}
        checking={false}
        stillMissing={false}
        onSetUp={noop}
        onRecheck={noop}
        onUsePersonal={noop}
      />
    )
    const link = view.getByRole('button', { name: 'Use my personal account for now' })
    expect(link.className).toMatch(/(^| )underline( |$)/)
  })
})
