// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { normalizeOrgEnterprise } from '../../../../../../shared/orca-org-enterprise'
import { EnterpriseSsoView } from './EnterpriseSsoView'
import {
  fixtureEnterprise,
  fixtureSsoProps,
  LIVE_SSO,
  MISSING_DOMAIN,
  ok,
  PENDING_DOMAIN,
  SCIM_SETUP_URL,
  SSO_FIXTURE_NOW
} from './enterprise-sso.fixtures'

afterEach(cleanup)

const headings = (container: HTMLElement): string[] =>
  [...container.querySelectorAll('section h3, section h2')].map((node) => node.textContent ?? '')

describe('directory sync (SCIM) is shown from the server flag alone', () => {
  // Exactly what auth sends for a team with SSO live; only `scim` differs between the two.
  const answer = (scim: unknown): unknown => ({
    orgId: 'org_acme',
    canManage: true,
    sso: {
      entitled: true,
      status: 'live',
      idp: 'Okta',
      required: true,
      ownerSignedInWithSso: true,
      domains: []
    },
    scim
  })

  it('is absent while the server says it is not available', () => {
    const enterprise = normalizeOrgEnterprise(answer({ available: false, status: 'unavailable' }))
    const { container } = render(<EnterpriseSsoView {...fixtureSsoProps(ok(enterprise))} />)
    expect(headings(container)).toEqual(['Single sign-on'])
    expect(container.textContent).not.toMatch(/Directory sync|SCIM/)
  })

  it('appears, with its controls, the moment the server says it is available', () => {
    const enterprise = normalizeOrgEnterprise(
      answer({
        available: true,
        status: 'active',
        lastChangeAt: SSO_FIXTURE_NOW - 3 * 60_000,
        lastChangeType: 'user.removed_from_org',
        setupUrl: SCIM_SETUP_URL
      })
    )
    const onOpenUrl = vi.fn()
    const { container } = render(
      <EnterpriseSsoView {...fixtureSsoProps(ok(enterprise), { onOpenUrl })} />
    )
    expect(headings(container)).toEqual(['Single sign-on', 'Directory sync'])
    expect(container.textContent).toContain('Active')
    expect(container.textContent).toContain('A teammate was removed · 3 minutes ago')
    fireEvent.click(screen.getByRole('button', { name: 'Open directory sync setup' }))
    expect(onOpenUrl).toHaveBeenCalledWith(SCIM_SETUP_URL)
  })

  it('needs a literal true: anything else from the server keeps it hidden', () => {
    for (const scim of [
      undefined,
      {},
      { available: 'true', status: 'active' },
      { available: 1, status: 'active' },
      { status: 'active', setupUrl: SCIM_SETUP_URL }
    ]) {
      const enterprise = normalizeOrgEnterprise(answer(scim))
      expect(enterprise.scim).toEqual({
        available: false,
        status: 'unavailable',
        lastChangeAt: null,
        lastChangeType: null,
        setupUrl: null
      })
      const { container, unmount } = render(
        <EnterpriseSsoView {...fixtureSsoProps(ok(enterprise))} />
      )
      expect(container.textContent).not.toMatch(/Directory sync|SCIM/)
      unmount()
    }
  })

  it('says what to do in each state, and never opens a link that is not https', () => {
    const state = (status: string, extra: Record<string, unknown> = {}) =>
      normalizeOrgEnterprise(answer({ available: true, status, ...extra }))
    const view = (status: string, extra?: Record<string, unknown>) => {
      cleanup()
      return render(<EnterpriseSsoView {...fixtureSsoProps(ok(state(status, extra)))} />).container
    }
    expect(view('not_enabled', { setupUrl: SCIM_SETUP_URL }).textContent).toContain(
      'Ask us to turn directory sync on for your team.'
    )
    // Not turned on for the team yet: nothing to open.
    expect(screen.queryByRole('button', { name: 'Open directory sync setup' })).toBeNull()
    expect(view('waiting', { setupUrl: SCIM_SETUP_URL }).textContent).toContain(
      'Waiting for first sync'
    )
    expect(screen.getByRole('button', { name: 'Open directory sync setup' })).toBeTruthy()
    expect(view('needs_sso').textContent).toContain('Turn on single sign-on first.')
    expect(state('active', { setupUrl: 'http://auth.example/org' }).scim.setupUrl).toBeNull()
    expect(state('active', { setupUrl: 'javascript:alert(1)' }).scim.setupUrl).toBeNull()
    // A kind of change this build does not know still shows when it arrived.
    expect(
      view('active', {
        lastChangeAt: SSO_FIXTURE_NOW - 3 * 60_000,
        lastChangeType: 'org.new_thing'
      }).textContent
    ).toContain('3 minutes ago')
  })
})

describe('single sign-on', () => {
  it('a team without the plan gets the shared locked state, and nothing to set up', () => {
    const onContactSales = vi.fn()
    const enterprise = fixtureEnterprise({ sso: { entitled: false } })
    const { container } = render(
      <EnterpriseSsoView {...fixtureSsoProps(ok(enterprise), { onContactSales })} />
    )
    expect(container.textContent).toContain('Single sign-on is part of Enterprise')
    expect(screen.queryByRole('button', { name: 'Set up SSO' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Contact sales' }))
    expect(onContactSales).toHaveBeenCalledWith('https://orca.dev/enterprise')
  })

  it('under the page banner the locked state is a plain line: one Contact sales per page', () => {
    const enterprise = fixtureEnterprise({ sso: { entitled: false } })
    render(<EnterpriseSsoView {...fixtureSsoProps(ok(enterprise), { underBanner: true })} />)
    expect(screen.queryByRole('button', { name: 'Contact sales' })).toBeNull()
  })

  it('an owner on the plan sets it up; the button opens the setup page', () => {
    const onOpenSetup = vi.fn()
    const { container } = render(
      <EnterpriseSsoView {...fixtureSsoProps(ok(fixtureEnterprise()), { onOpenSetup })} />
    )
    fireEvent.click(screen.getByRole('button', { name: 'Set up SSO' }))
    expect(onOpenSetup).toHaveBeenCalledTimes(1)
    // The chevron beside it copies the link instead.
    expect(screen.getByRole('button', { name: 'More link options' })).toBeTruthy()
    expect(container.textContent).toContain('works without signing in and expires in 1 hour')
    expect(container.textContent).toContain('Not yet')
  })

  it('shows why the setup page could not be opened', () => {
    const { container } = render(
      <EnterpriseSsoView
        {...fixtureSsoProps(ok(fixtureEnterprise()), {
          setupNotice: 'For your team’s safety, sign out and sign in to Orca again.'
        })}
      />
    )
    expect(container.textContent).toContain('sign out and sign in to Orca again')
  })

  it('live: names the identity provider, says SSO is required, and offers Manage', () => {
    const { container } = render(
      <EnterpriseSsoView {...fixtureSsoProps(ok(fixtureEnterprise({ sso: LIVE_SSO })))} />
    )
    expect(container.textContent).toContain('Your team signs in with Okta.')
    expect(container.textContent).toContain('Every member signs in with SSO.')
    expect(container.textContent).toContain('Required')
    expect(screen.getByRole('button', { name: 'Manage' })).toBeTruthy()
    expect(container.textContent).toContain('acme.com')
    expect(container.textContent).toContain('Verified')
  })

  it('says so while owners can still sign in another way, and when older sign-ins end', () => {
    const enterprise = fixtureEnterprise({
      sso: { ...LIVE_SSO, ownerSignedInWithSso: false, sessionsEndAt: SSO_FIXTURE_NOW + 3_600_000 }
    })
    const { container } = render(<EnterpriseSsoView {...fixtureSsoProps(ok(enterprise))} />)
    expect(container.textContent).toContain('Owners can still sign in another way')
    expect(container.textContent).toMatch(
      /Sign-ins made before SSO was turned on end on \w{3} \d{1,2}, 2026 at \d{1,2}:00\s?[AP]M\. Members then sign in again with SSO\./
    )
    // Status chips read in sentence case, like the neutral ones beside them.
    expect(container.querySelector('.uppercase')).toBeNull()
  })

  it('an admin sees the state and cannot change it', () => {
    const enterprise = fixtureEnterprise({ canManage: false, sso: LIVE_SSO })
    const { container } = render(<EnterpriseSsoView {...fixtureSsoProps(ok(enterprise))} />)
    expect(container.textContent).toContain('Only a team owner can change single sign-on.')
    expect(screen.queryByRole('button', { name: 'Manage' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Add domain' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull()
  })

  it('a lapsed plan keeps SSO on and required, and stops changes instead of selling', () => {
    const enterprise = fixtureEnterprise({ sso: { ...LIVE_SSO, entitled: false } })
    const { container } = render(<EnterpriseSsoView {...fixtureSsoProps(ok(enterprise))} />)
    expect(container.textContent).toContain('Required')
    expect(container.textContent).toContain('your plan no longer includes changing it')
    expect(container.textContent).not.toContain('is part of Enterprise')
    expect(screen.queryByRole('button', { name: 'Manage' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Contact us' })).toBeTruthy()
    // A contact page offers no Copy link; that is for sign-in surfaces.
    expect(screen.queryByRole('button', { name: 'More link options' })).toBeNull()
  })

  it('domains: add, the record to publish, check and remove', () => {
    const onAdd = vi.fn()
    const onVerify = vi.fn()
    const onRemove = vi.fn()
    const onCopy = vi.fn()
    const enterprise = fixtureEnterprise({
      sso: { status: 'test', domains: [PENDING_DOMAIN, MISSING_DOMAIN] }
    })
    const props = fixtureSsoProps(ok(enterprise))
    const { container } = render(
      <EnterpriseSsoView
        {...props}
        domains={{
          ...props.domains,
          onAdd,
          onVerify,
          onRemove,
          onCopy,
          notice: { domain: 'acme.com', message: 'We couldn’t find the record yet.' }
        }}
      />
    )
    expect(container.textContent).toContain('_orca-verify.acme.com')
    expect(container.textContent).toContain(PENDING_DOMAIN.record.value)
    expect(container.textContent).toContain('Record missing')
    expect(container.textContent).toContain('We couldn’t find the record yet.')
    fireEvent.click(screen.getAllByRole('button', { name: 'Check record' })[0]!)
    expect(onVerify).toHaveBeenCalledWith('acme.com')
    fireEvent.click(screen.getAllByRole('button', { name: 'Remove' })[1]!)
    expect(onRemove).toHaveBeenCalledWith('acme.io')
    fireEvent.click(screen.getAllByRole('button', { name: 'Copy Value' })[0]!)
    expect(onCopy).toHaveBeenCalledWith(PENDING_DOMAIN.record.value)
    fireEvent.change(screen.getByLabelText('Domain to add'), {
      target: { value: ' new.acme.com ' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Add domain' }))
    expect(onAdd).toHaveBeenCalledWith('new.acme.com')
  })

  it('loading and a failed load', () => {
    const onRetry = vi.fn()
    render(<EnterpriseSsoView {...fixtureSsoProps({ status: 'loading' })} />)
    expect(screen.getByRole('status', { name: 'Loading single sign-on' })).toBeTruthy()
    cleanup()
    render(
      <EnterpriseSsoView
        {...fixtureSsoProps(
          { status: 'error', message: 'Couldn’t reach Orca Cloud.' },
          { onRetry }
        )}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(onRetry).toHaveBeenCalledTimes(1)
  })
})

describe('reading auth’s answer', () => {
  it('a malformed or empty answer reads as locked and off, never as on', () => {
    for (const value of [null, 'x', [], {}, { sso: 'live', scim: true }]) {
      expect(normalizeOrgEnterprise(value)).toEqual(
        fixtureEnterprise({ canManage: false, sso: { entitled: false } })
      )
    }
  })

  it('drops domains it cannot show and unknown statuses', () => {
    const enterprise = normalizeOrgEnterprise({
      canManage: true,
      sso: {
        entitled: true,
        status: 'something_new',
        required: 'yes',
        domains: [
          PENDING_DOMAIN,
          { domain: 'x.com', status: 'weird', record: PENDING_DOMAIN.record },
          7
        ]
      }
    })
    expect(enterprise.sso.status).toBe('off')
    expect(enterprise.sso.required).toBe(false)
    expect(enterprise.sso.domains).toEqual([PENDING_DOMAIN])
  })
})
