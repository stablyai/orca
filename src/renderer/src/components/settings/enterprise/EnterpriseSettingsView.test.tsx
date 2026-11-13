// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CloudAuditEvent } from '../../../../../shared/cloud-api/cloud-api-types'
import {
  EnterpriseSettingsView as RawView,
  type EnterpriseSettingsViewProps
} from './EnterpriseSettingsView'
import { FIXTURE_EVENTS, FIXTURE_NOW, fixtureAuditProps } from './enterprise-audit.fixtures'
import { auditCategoryLabel, auditEventSentence, isKnownAuditAction } from './enterprise-audit-copy'

afterEach(cleanup)

/** The view as the pane feeds it: the audit log's answer says which side of the plan the team is on. */
function EnterpriseSettingsView(
  props: Omit<EnterpriseSettingsViewProps, 'ssoIncluded'> & { ssoIncluded?: boolean | null }
): React.JSX.Element {
  const status = props.audit.log.status
  const derived = status === 'ok' ? true : status === 'upsell' ? false : null
  return (
    <RawView
      {...props}
      ssoIncluded={props.ssoIncluded === undefined ? derived : props.ssoIncluded}
    />
  )
}

const EMPTY = {
  status: 'ok' as const,
  events: [],
  hasMore: false,
  loadingMore: false,
  moreError: null,
  refreshing: false
}

function rows(container: HTMLElement): string[] {
  return [...container.querySelectorAll('ul[aria-label="Audit log"] > li')].map((row) =>
    [...row.children].map((cell) => cell.textContent).join(' | ')
  )
}

describe('audit log', () => {
  it('lists who did what to what and when, newest first, from every source', () => {
    const { container } = render(<EnterpriseSettingsView audit={fixtureAuditProps()} />)
    expect(rows(container)).toEqual([
      'Changed secret STRIPE_SECRET_KEY | Secrets | Grace Hopper | 4 minutes ago',
      'Changed the role of Grace Hopper | Members | You | 38 minutes ago',
      'Shared a link to a port on workspace “checkout-redesign” | Workspaces | Grace Hopper | 3 hours ago',
      'Started workspace “nightly-evals” | Workspaces | Grace Hopper via API key | 5 hours ago',
      'Removed Linus Park from the team | Members | You | yesterday',
      'Turned off a routine | Routines | Orca | yesterday',
      'Created API key “GitHub Actions deploy” | API keys | Linus Park · Former member | 2 days ago',
      'Added secret ANTHROPIC_API_KEY | Secrets | You | 3 days ago',
      'Changed agent access | Settings | You | 6 days ago',
      'Connected an app | Connected apps | Grace Hopper via MCP | 9 days ago'
    ])
  })

  it('never renders a secret value, hint or raw user id inline; the id stays one hover away', () => {
    const leaky: CloudAuditEvent = {
      ...FIXTURE_EVENTS[0]!,
      detail: { scope: 'org', hint: 'wxyz', value: 'sk-live-should-not-show' }
    }
    const { container } = render(
      <EnterpriseSettingsView
        audit={fixtureAuditProps({ log: { ...EMPTY, events: [leaky, FIXTURE_EVENTS[6]!] } })}
      />
    )
    expect(container.textContent).not.toMatch(/wxyz|should-not-show/)
    expect(container.textContent).not.toContain('u_linus')
    expect(container.querySelector('[title="u_linus"]')).not.toBeNull()
  })

  it('shows an action this version does not know by its machine name instead of hiding it', () => {
    const unknown: CloudAuditEvent = {
      ...FIXTURE_EVENTS[0]!,
      id: 'aud_new',
      category: 'security',
      action: 'sso.something_new'
    }
    const { container } = render(
      <EnterpriseSettingsView audit={fixtureAuditProps({ log: { ...EMPTY, events: [unknown] } })} />
    )
    expect(rows(container)).toEqual(['sso.something_new | Security | Grace Hopper | 4 minutes ago'])
  })

  it('words every single sign-on and directory sync action auth sends', () => {
    // The actions in orca-cloud apps/auth/src/audit/sso-audit.ts.
    const actions = [
      'sso.setup_link_created',
      'sso.configured',
      'sso.went_live',
      'sso.removed',
      'sso.sign_in_refused',
      'sso.sessions_ended',
      'sso.domain_added',
      'sso.domain_verified',
      'sso.domain_removed',
      'sso.domain_record_missing',
      'scim.enabled',
      'scim.disabled',
      'scim.key_created',
      'scim.key_revoked',
      'scim.group_changed',
      'scim.group_membership_changed'
    ]
    for (const action of actions) {
      expect(isKnownAuditAction(action)).toBe(true)
      const sentence = auditEventSentence({ ...FIXTURE_EVENTS[0]!, action, target: null })
      expect(sentence).not.toContain('.')
      expect(sentence).not.toContain('_')
    }
    const about = (action: string, label: string): string =>
      auditEventSentence({
        ...FIXTURE_EVENTS[0]!,
        action,
        target: { type: 'sso_connection', id: null, label }
      })
    expect(about('sso.went_live', 'Okta')).toBe('Turned on single sign-on with Okta')
    expect(about('sso.domain_verified', 'acme.com')).toBe('Verified email domain acme.com')
    expect(about('sso.domain_record_missing', 'acme.com')).toBe(
      'Found the DNS record for acme.com missing'
    )
  })

  it('pages with Show more, and keeps the list when a page fails', () => {
    const onLoadMore = vi.fn()
    const { rerender, container } = render(
      <EnterpriseSettingsView audit={fixtureAuditProps({ onLoadMore })} />
    )
    fireEvent.click(screen.getByRole('button', { name: 'Show more' }))
    expect(onLoadMore).toHaveBeenCalledTimes(1)
    rerender(
      <EnterpriseSettingsView
        audit={fixtureAuditProps({
          onLoadMore,
          log: { ...EMPTY, events: FIXTURE_EVENTS, hasMore: true, loadingMore: true }
        })}
      />
    )
    // Busy, not disabled: the button keeps focus, and a second click does nothing.
    const busy = screen.getByRole('button', { name: 'Show more' })
    expect(busy.getAttribute('aria-busy')).toBe('true')
    fireEvent.click(busy)
    expect(onLoadMore).toHaveBeenCalledTimes(1)
    rerender(
      <EnterpriseSettingsView
        audit={fixtureAuditProps({
          onLoadMore,
          log: {
            ...EMPTY,
            events: FIXTURE_EVENTS,
            hasMore: true,
            moreError: 'Couldn’t reach Orca Cloud.'
          }
        })}
      />
    )
    expect(rows(container)).toHaveLength(FIXTURE_EVENTS.length)
    expect(screen.getByText('Couldn’t reach Orca Cloud.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(onLoadMore).toHaveBeenCalledTimes(2)
    // The last page has no Show more.
    rerender(
      <EnterpriseSettingsView
        audit={fixtureAuditProps({ log: { ...EMPTY, events: FIXTURE_EVENTS } })}
      />
    )
    expect(screen.queryByRole('button', { name: 'Show more' })).toBeNull()
  })

  it('offers both filters and the export, and exports once per click', () => {
    const onExport = vi.fn()
    const { rerender } = render(<EnterpriseSettingsView audit={fixtureAuditProps({ onExport })} />)
    expect(screen.getByRole('combobox', { name: 'Filter by activity' }).textContent).toBe(
      'All activity'
    )
    expect(screen.getByRole('combobox', { name: 'Filter by person' }).textContent).toBe('Everyone')
    fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }))
    expect(onExport).toHaveBeenCalledTimes(1)
    rerender(
      <EnterpriseSettingsView
        audit={fixtureAuditProps({ onExport, exportState: { status: 'exporting' } })}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }))
    expect(onExport).toHaveBeenCalledTimes(1)
    rerender(
      <EnterpriseSettingsView
        audit={fixtureAuditProps({ onExport, exportState: { status: 'done', truncated: true } })}
      />
    )
    expect(screen.getByRole('status').textContent).toContain('newest 5,000 events')
  })

  it('shows the chosen filters, and an empty filtered list offers the way back', () => {
    const onFilter = vi.fn()
    render(
      <EnterpriseSettingsView
        audit={fixtureAuditProps({
          onFilter,
          log: EMPTY,
          filters: { category: 'secrets', actor: 'u_grace' }
        })}
      />
    )
    expect(screen.getByRole('combobox', { name: 'Filter by activity' }).textContent).toBe('Secrets')
    expect(screen.getByRole('combobox', { name: 'Filter by person' }).textContent).toBe(
      'Grace Hopper'
    )
    expect(screen.getByText('Nothing matches')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }))
    expect(onFilter).toHaveBeenCalledWith({ category: null, actor: null })
    // Nothing to export.
    expect(screen.getByRole('button', { name: 'Export CSV' }).hasAttribute('disabled')).toBe(true)
  })

  it('says nothing is recorded yet when the log is empty and unfiltered', () => {
    render(<EnterpriseSettingsView audit={fixtureAuditProps({ log: EMPTY, actors: [] })} />)
    expect(screen.getByText('Nothing recorded yet')).toBeTruthy()
    expect(screen.queryByRole('combobox')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Clear filters' })).toBeNull()
  })

  it('words a load failure and retries', () => {
    const onRetry = vi.fn()
    render(
      <EnterpriseSettingsView
        audit={fixtureAuditProps({
          onRetry,
          log: { status: 'error', message: 'Orca Cloud is down.' }
        })}
      />
    )
    expect(screen.getByText('Orca Cloud is down.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(onRetry).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('button', { name: 'Export CSV' })).toBeNull()
  })
})

describe('without the Enterprise plan', () => {
  it('a team with neither gets ONE Contact sales, in a banner, and a plain line in each block', () => {
    const onContactSales = vi.fn()
    const { container } = render(
      <EnterpriseSettingsView
        audit={fixtureAuditProps({ log: { status: 'upsell' }, actors: [], onContactSales })}
      />
    )
    expect(
      screen.getByText(
        'Single sign-on, two-factor requirements and the audit log are part of Enterprise'
      )
    ).toBeTruthy()
    // The blocks keep their titles and say what they are, without a second button.
    expect(screen.getByText('Single sign-on and provisioning')).toBeTruthy()
    expect(screen.getByText('Audit log')).toBeTruthy()
    expect(container.textContent).toContain('so your full history is here from the day you upgrade')
    expect(screen.queryByText('Audit log is part of Enterprise')).toBeNull()
    expect(rows(container)).toEqual([])
    expect(screen.queryByRole('combobox')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Export CSV' })).toBeNull()
    const contact = screen.getAllByRole('button', { name: 'Contact sales' })
    expect(contact).toHaveLength(1)
    fireEvent.click(contact[0]!)
    expect(onContactSales).toHaveBeenCalledWith('https://orca.dev/enterprise')
    // Contact sales is not a sign-in page: a plain button, no Copy link chevron (AUTH-ONLY-COPY-LINK).
    expect(screen.queryAllByRole('button', { name: 'More link options' })).toHaveLength(0)
  })

  it('a team missing only the audit log keeps the button on that block, with no banner', () => {
    const onContactSales = vi.fn()
    render(
      <EnterpriseSettingsView
        ssoIncluded
        audit={fixtureAuditProps({ log: { status: 'upsell' }, actors: [], onContactSales })}
      />
    )
    expect(
      screen.queryByText(
        'Single sign-on, two-factor requirements and the audit log are part of Enterprise'
      )
    ).toBeNull()
    expect(screen.getByText('Audit log is part of Enterprise')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Contact sales' }))
    expect(onContactSales).toHaveBeenCalledWith('https://orca.dev/enterprise')
  })

  it("uses billing's own plan name and contact page", () => {
    const onContactSales = vi.fn()
    render(
      <EnterpriseSettingsView
        audit={fixtureAuditProps({
          log: { status: 'upsell' },
          contact: { planName: 'Scale', contactUrl: 'https://orca.dev/scale' },
          onContactSales
        })}
      />
    )
    expect(
      screen.getByText(
        'Single sign-on, two-factor requirements and the audit log are part of Scale'
      )
    ).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Contact sales' }))
    expect(onContactSales).toHaveBeenCalledWith('https://orca.dev/scale')
  })
})

describe('on the Enterprise plan', () => {
  it('never sends the team to sales: single sign-on is set up with us, with Contact us', () => {
    const onContactSales = vi.fn()
    const { container } = render(
      <EnterpriseSettingsView audit={fixtureAuditProps({ onContactSales })} />
    )
    expect(container.textContent).not.toMatch(/part of Enterprise|Contact sales/)
    expect(screen.getByText('Single sign-on is set up with us')).toBeTruthy()
    expect(screen.getByText('To set up or change single sign-on, contact us.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Contact us' }))
    expect(onContactSales).toHaveBeenCalledWith('https://orca.dev/enterprise')
  })

  it('says nothing about single sign-on until the plan is known', () => {
    const { container } = render(
      <EnterpriseSettingsView
        audit={fixtureAuditProps({ log: { status: 'loading' }, actors: [] })}
      />
    )
    expect(container.textContent).not.toMatch(/Single sign-on|Contact/)
    expect(screen.getByText('Audit log')).toBeTruthy()
  })
})

describe('slots', () => {
  it('lets the SSO and policy owners replace or add their blocks, in order above the audit log', () => {
    const { container } = render(
      <EnterpriseSettingsView
        audit={fixtureAuditProps()}
        singleSignOn={<section data-testid="sso">SSO</section>}
        policies={<section data-testid="mfa">Require MFA</section>}
      />
    )
    expect(screen.queryByText('Single sign-on is set up with us')).toBeNull()
    const order = [...container.querySelectorAll('[id^="cloud-enterprise-"]')].map(
      (node) => node.id
    )
    expect(order).toEqual([
      'cloud-enterprise-sso',
      'cloud-enterprise-policies',
      'cloud-enterprise-audit-log'
    ])
  })
})

describe('copy', () => {
  it('names every category and words every action the control plane records today', () => {
    expect(auditCategoryLabel('api_keys')).toBe('API keys')
    const recorded = [
      'api_key.create',
      'api_key.revoke',
      'workspace_token.issue',
      'settings.update',
      'workspace.create',
      'workspace.destroy',
      'workspace.sleep',
      'workspace.wake',
      'workspace.archive',
      'workspace.unarchive',
      'workspace.rename',
      'workspace.share_create',
      'workspace.share_revoke',
      'workspace.message',
      'workspace.attachment',
      'workspace.session.create',
      'workspace.session.cancel',
      'workspace.session.rename',
      'sandbox.ssh_key_added',
      'sandbox.ssh_key_removed',
      'project.create',
      'project.update',
      'project.delete',
      'mcp.approval_create',
      'mcp.authorize',
      'mcp.grant_revoke',
      'mcp.code_replay',
      'mcp.refresh_replay',
      'secret.created',
      'secret.updated',
      'secret.deleted',
      'member.removed',
      'member.left',
      'member.role_changed',
      'member.role_synced',
      'routine.create',
      'routine.update',
      'routine.delete',
      'routine.disable',
      'routine.run',
      'routine.run.start',
      'routine.run.finish',
      'routine.rotate_webhook',
      'workspace.shared_with_team',
      'workspace.made_private',
      'workspace.owner_changed',
      // Sent by auth and billing (AUDIT-AUTH-EVENTS).
      'member.invited',
      'member.invite_revoked',
      'member.joined',
      'team.created',
      'team.renamed',
      'team.deleted',
      'billing.plan_started',
      'billing.plan_changed',
      'billing.plan_canceled',
      'billing.cancel_scheduled',
      'billing.cancel_reverted',
      'billing.seats_changed',
      'billing.overage_enabled',
      'billing.overage_disabled',
      'billing.spend_cap_changed'
    ]
    expect(recorded.filter((action) => !isKnownAuditAction(action))).toEqual([])
  })

  it('words the events auth and billing send', () => {
    const base: CloudAuditEvent = {
      id: 'a',
      at: FIXTURE_NOW,
      category: 'members',
      action: 'member.invited',
      actor: { kind: 'person', userId: 'u_ada', name: 'Ada Lovelace', via: null },
      target: { type: 'invite', id: null, label: 'new@acme.dev' },
      detail: { role: 'member' }
    }
    const say = (action: string, target: CloudAuditEvent['target'] = null): string =>
      auditEventSentence({ ...base, action, target })
    expect(auditEventSentence(base)).toBe('Invited new@acme.dev')
    expect(say('member.invite_revoked', base.target)).toBe('Canceled the invite for new@acme.dev')
    expect(say('member.joined', { type: 'member', id: 'u_x', label: 'Bo' })).toBe('Joined the team')
    expect(say('team.renamed', { type: 'team', id: null, label: 'Acme Labs' })).toBe(
      'Renamed the team to “Acme Labs”'
    )
    expect(say('team.deleted', { type: 'team', id: null, label: 'Acme Labs' })).toBe(
      'Deleted the team'
    )
  })

  it('puts what billing recorded into the sentence, and falls back when it recorded nothing', () => {
    const say = (action: string, detail: Record<string, unknown> | null): string =>
      auditEventSentence(
        {
          id: 'b',
          at: FIXTURE_NOW,
          category: 'billing',
          action,
          actor: { kind: 'system', userId: null, name: null, via: null },
          target: { type: 'plan', id: null },
          detail
        },
        undefined,
        'en-US'
      )
    expect(say('billing.plan_started', { plan: 'team', interval: 'month', seats: 2 })).toBe(
      'Plan started (Team, monthly)'
    )
    expect(say('billing.plan_started', null)).toBe('Plan started')
    expect(say('billing.plan_changed', { plan: 'team', interval: 'year' })).toBe(
      'Plan changed to Team, annual'
    )
    expect(say('billing.plan_changed', { plan: 'team' })).toBe('Plan changed')
    expect(say('billing.seats_changed', { seats: 5, previousSeats: 3 })).toBe(
      'Seats changed from 3 to 5'
    )
    expect(say('billing.seats_changed', { seats: 5 })).toBe('Seats changed')
    expect(say('billing.plan_canceled', { plan: 'team' })).toBe('Plan ended')
    expect(say('billing.cancel_scheduled', { endsAt: Date.UTC(2026, 11, 2, 12) })).toBe(
      'Plan set to end on Dec 2, 2026'
    )
    expect(say('billing.cancel_scheduled', null)).toBe('Plan set to end at the next renewal')
    expect(say('billing.cancel_reverted', null)).toBe('Plan set to renew again')
    expect(
      say('billing.spend_cap_changed', { spendCapCents: 5000, previousSpendCapCents: null })
    ).toBe('Changed the monthly spend cap to $50')
    expect(say('billing.spend_cap_changed', { spendCapCents: 1250 })).toBe(
      'Changed the monthly spend cap to $12.50'
    )
    // Back to the plan's default cap: no amount to show.
    expect(say('billing.spend_cap_changed', { previousSpendCapCents: 5000 })).toBe(
      'Changed the monthly spend cap'
    )
    expect(say('billing.overage_enabled', null)).toBe('Turned on overage')
    expect(say('billing.overage_disabled', null)).toBe('Turned off overage')
  })

  it('words a workspace being shared with the team, made private, and handed to a new owner (EP-3)', () => {
    const event = (action: string, label: string | null): CloudAuditEvent => ({
      id: 'v',
      at: FIXTURE_NOW,
      category: 'workspaces',
      action,
      actor: { kind: 'person', userId: 'u_ada', name: 'Ada Lovelace', via: null },
      target: { type: 'workspace', id: 'sbx_1', label },
      detail: { from: 'private', to: 'team' }
    })
    expect(auditEventSentence(event('workspace.shared_with_team', 'checkout-redesign'))).toBe(
      'Shared workspace “checkout-redesign” with the team'
    )
    expect(auditEventSentence(event('workspace.made_private', 'checkout-redesign'))).toBe(
      'Made workspace “checkout-redesign” private'
    )
    expect(auditEventSentence(event('workspace.shared_with_team', null))).toBe(
      'Shared a workspace with the team'
    )
    expect(auditEventSentence(event('workspace.made_private', null))).toBe(
      'Made a workspace private'
    )
    expect(auditEventSentence(event('workspace.owner_changed', 'checkout-redesign'))).toBe(
      'Changed the owner of workspace “checkout-redesign”'
    )
  })

  it('falls back to the plain sentence when the target has no name', () => {
    const event: CloudAuditEvent = {
      id: 'a',
      at: FIXTURE_NOW,
      category: 'members',
      action: 'member.removed',
      actor: { kind: 'system', userId: null, name: null, via: null },
      target: { type: 'member', id: 'u_x', label: null },
      detail: null
    }
    expect(auditEventSentence(event)).toBe('Removed a teammate')
    expect(
      auditEventSentence({ ...event, target: { type: 'member', id: 'u_x', label: 'Bo' } })
    ).toBe('Removed Bo from the team')
  })
})
