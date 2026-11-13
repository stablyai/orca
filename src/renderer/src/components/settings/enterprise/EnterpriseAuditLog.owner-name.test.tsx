// @vitest-environment happy-dom
// EP-3b: handing a workspace to a teammate must name them, even when the control plane cannot.
// It only knows people who have used Orca Cloud in the team; the team roster knows everyone.
import { cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { CloudAuditEvent } from '../../../../../shared/cloud-api/cloud-api-types'
import type { OrcaProfileAuthStatus } from '../../../../../shared/orca-profiles'
import { EnterpriseAuditLog } from './EnterpriseAuditLog'
import { FIXTURE_NOW, fixtureAuditProps } from './enterprise-audit.fixtures'
import { auditEventSentence, unnamedPersonIn } from './enterprise-audit-copy'

const ROSTER = {
  status: 'ok' as const,
  roster: {
    viewerRole: 'owner' as const,
    canManageMembers: true,
    members: [
      {
        userId: 'u_ada',
        email: 'ada@acme.dev',
        displayName: 'Ada Lovelace',
        role: 'owner' as const
      },
      {
        userId: 'u_member',
        email: 'member@acme.dev',
        displayName: 'Orca Staging Member',
        role: 'member' as const
      },
      { userId: 'u_noname', email: 'quiet@acme.dev', displayName: '', role: 'member' as const }
    ],
    pendingInvites: []
  }
}

const SIGNED_IN: OrcaProfileAuthStatus = {
  activeProfileId: 'p1',
  configured: true,
  state: 'connected',
  persistence: 'encrypted',
  cloud: {
    cloudProfileId: 'cp',
    userId: 'u_ada',
    email: 'ada@acme.dev',
    activeOrgId: 'org_ep3b',
    linkedAt: 1
  },
  organizations: [{ orgId: 'org_ep3b', name: 'Acme', role: 'owner' }]
}

function ownerChange(detail: Record<string, unknown>, id = 'own_1'): CloudAuditEvent {
  return {
    id,
    at: FIXTURE_NOW,
    category: 'workspaces',
    action: 'workspace.owner_changed',
    actor: { kind: 'person', userId: 'u_ada', name: 'Ada Lovelace', via: null },
    target: { type: 'workspace', id: 'sbx_1', label: 'endpass-own' },
    detail
  }
}

const listed = (events: CloudAuditEvent[]) =>
  fixtureAuditProps({
    log: {
      status: 'ok',
      events,
      hasMore: false,
      loadingMore: false,
      moreError: null,
      refreshing: false
    }
  })

const sentences = (container: HTMLElement): string[] =>
  [...container.querySelectorAll('ul[aria-label="Audit log"] > li')].map(
    (row) => row.children[0]?.textContent ?? ''
  )

let orgMembersList: ReturnType<typeof vi.fn>

beforeEach(() => {
  orgMembersList = vi.fn(async () => ROSTER)
  vi.stubGlobal('api', { orcaProfiles: { orgMembersList } })
  useAppStore.setState({ orcaProfileAuthStatus: SIGNED_IN })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  useAppStore.setState({ orcaProfileAuthStatus: null })
})

describe('the new owner of a workspace', () => {
  it('is named from the team roster when the control plane sent no name', async () => {
    // What dev sent on n46: the ids, no toUserName (the new owner had never used Orca Cloud).
    const { container } = render(
      <EnterpriseAuditLog
        {...listed([ownerChange({ fromUserId: 'u_ada', toUserId: 'u_member' })])}
      />
    )
    // Before the roster answers: the sentence that needs no name, never an id.
    expect(sentences(container)).toEqual(['Changed the owner of workspace “endpass-own”'])
    await waitFor(() =>
      expect(sentences(container)).toEqual([
        'Made Orca Staging Member the owner of workspace “endpass-own”'
      ])
    )
    expect(orgMembersList).toHaveBeenCalledWith({ orgId: 'org_ep3b' })
    expect(container.textContent).not.toContain('u_member')
  })

  it('falls back to the email, then to the no-name sentence, and never shows a raw id', async () => {
    const { container } = render(
      <EnterpriseAuditLog
        {...listed([
          ownerChange({ fromUserId: 'u_ada', toUserId: 'u_noname' }, 'own_1'),
          ownerChange({ fromUserId: 'u_ada', toUserId: 'u_gone' }, 'own_2')
        ])}
      />
    )
    await waitFor(() =>
      expect(sentences(container)).toEqual([
        'Made quiet@acme.dev the owner of workspace “endpass-own”',
        'Changed the owner of workspace “endpass-own”'
      ])
    )
    expect(container.textContent).not.toMatch(/u_noname|u_gone/)
  })

  it("keeps the control plane's name when it sent one, and does not read the roster for it", async () => {
    const { container } = render(
      <EnterpriseAuditLog
        {...listed([
          ownerChange(
            { fromUserId: 'u_ada', toUserId: 'u_member', toUserName: 'Grace Hopper' },
            'own_1'
          ),
          // Took it themselves, and a new owner who has left: neither needs a name looked up.
          ownerChange({ fromUserId: 'u_bob', toUserId: 'u_ada' }, 'own_2'),
          ownerChange(
            {
              fromUserId: 'u_ada',
              toUserId: 'u_left',
              toUserName: 'Linus Park',
              toUserFormer: true
            },
            'own_3'
          )
        ])}
      />
    )
    expect(sentences(container)).toEqual([
      'Made Grace Hopper the owner of workspace “endpass-own”',
      'Took ownership of workspace “endpass-own”',
      'Made a former member the owner of workspace “endpass-own”'
    ])
    await Promise.resolve()
    expect(orgMembersList).not.toHaveBeenCalled()
  })

  it('names the member a role change is about the same way', async () => {
    const roleChange: CloudAuditEvent = {
      id: 'role_1',
      at: FIXTURE_NOW,
      category: 'members',
      action: 'member.role_changed',
      actor: { kind: 'person', userId: 'u_ada', name: 'Ada Lovelace', via: null },
      target: { type: 'member', id: 'u_member', label: null },
      detail: { role: 'admin' }
    }
    const { container } = render(<EnterpriseAuditLog {...listed([roleChange])} />)
    await waitFor(() =>
      expect(sentences(container)).toEqual(['Changed the role of Orca Staging Member'])
    )
    // A label from the control plane wins, and needs no roster read.
    expect(
      unnamedPersonIn({ ...roleChange, target: { type: 'member', id: 'u_member', label: 'Bo' } })
    ).toBeNull()
  })

  it('reads the roster only for rows that point at someone unnamed', () => {
    expect(unnamedPersonIn(ownerChange({ fromUserId: 'u_ada', toUserId: 'u_member' }))).toBe(
      'u_member'
    )
    expect(
      unnamedPersonIn(ownerChange({ toUserId: 'u_member', toUserName: 'Grace Hopper' }))
    ).toBeNull()
    expect(unnamedPersonIn(ownerChange({ toUserId: 'u_ada' }))).toBeNull()
    expect(
      unnamedPersonIn({
        ...ownerChange({ toUserId: 'u_member' }),
        action: 'workspace.made_private'
      })
    ).toBeNull()
    // The pure sentence takes any resolver.
    expect(
      auditEventSentence(ownerChange({ toUserId: 'u_member' }), undefined, undefined, () => 'Bo')
    ).toBe('Made Bo the owner of workspace “endpass-own”')
  })
})
