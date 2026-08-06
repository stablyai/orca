// @vitest-environment happy-dom

import type { ReactNode } from 'react'
import { render, screen, cleanup } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OrcaOrgMembersRoster } from '../../../../shared/orca-profiles'
import { OrcaProfileOrgMembersDialog } from './OrcaProfileOrgMembersDialog'

vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: ReactNode }) => <div>{children}</div>
}))

vi.mock('@/components/ui/scroll-area', () => ({
  ScrollArea: ({ children }: { children: ReactNode }) => <div>{children}</div>
}))

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <span>{children}</span>
}))

vi.mock('@/components/ui/button', () => ({
  Button: ({
    children,
    disabled,
    'aria-label': ariaLabel,
    type
  }: {
    children?: ReactNode
    disabled?: boolean
    'aria-label'?: string
    type?: 'button' | 'submit'
  }) => (
    <button aria-label={ariaLabel} disabled={disabled} type={type}>
      {children}
    </button>
  )
}))

vi.mock('@/components/ui/input', () => ({
  Input: ({ placeholder, disabled }: { placeholder?: string; disabled?: boolean }) => (
    <input placeholder={placeholder} disabled={disabled} />
  )
}))

vi.mock('@/components/ui/select', () => ({
  Select: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectItem: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectValue: () => null,
  SelectTrigger: ({
    disabled,
    'aria-label': ariaLabel,
    children
  }: {
    disabled?: boolean
    'aria-label'?: string
    children?: ReactNode
  }) => (
    <button aria-label={ariaLabel} disabled={disabled}>
      {children}
    </button>
  )
}))

const managerRoster: OrcaOrgMembersRoster = {
  members: [
    { userId: 'user-viewer', email: 'me@example.com', displayName: 'Me', role: 'admin' },
    { userId: 'user-2', email: 'other@example.com', displayName: 'Other', role: 'member' },
    { userId: null, email: 'never@example.com', role: 'member' }
  ],
  pendingInvites: [{ email: 'pending@example.com', role: 'member', createdAt: 1 }],
  viewerRole: 'owner',
  canManageMembers: true
}

const memberRoster: OrcaOrgMembersRoster = {
  members: [
    { userId: 'user-1', email: 'boss@example.com', displayName: 'Boss', role: 'owner' },
    { userId: 'user-2', email: 'peer@example.com', displayName: 'Peer', role: 'member' }
  ],
  pendingInvites: [],
  viewerRole: 'member',
  canManageMembers: false
}

function stubOrgMembersApi(roster: OrcaOrgMembersRoster): void {
  ;(window as unknown as { api: unknown }).api = {
    orcaProfiles: {
      orgMembersList: vi.fn().mockResolvedValue({ status: 'ok', roster })
    }
  }
}

describe('OrcaProfileOrgMembersDialog', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('shows the invite form and a role select per member for managers', async () => {
    stubOrgMembersApi(managerRoster)
    render(
      <OrcaProfileOrgMembersDialog
        open
        onOpenChange={() => {}}
        orgId="org-1"
        orgName="Acme"
        viewerUserId="user-viewer"
      />
    )

    expect(await screen.findByText('other@example.com')).toBeTruthy()
    // Invite form present.
    expect(screen.getByPlaceholderText('teammate@example.com')).toBeTruthy()
    // Pending invite listed with a revoke action.
    expect(screen.getByText('pending@example.com')).toBeTruthy()
    // One role select per member.
    expect(screen.getAllByLabelText('Role')).toHaveLength(3)
    // Self and the never-signed-in row disable their remove action; the peer's stays enabled.
    const removeButtons = screen.getAllByLabelText('Remove teammate') as HTMLButtonElement[]
    expect(removeButtons).toHaveLength(3)
    expect(removeButtons.filter((button) => button.disabled)).toHaveLength(2)
    // Never-signed-in explanation is present.
    expect(screen.getByText("They haven't signed in to Orca yet.")).toBeTruthy()
  })

  it('renders a read-only roster for non-managers', async () => {
    stubOrgMembersApi(memberRoster)
    render(
      <OrcaProfileOrgMembersDialog
        open
        onOpenChange={() => {}}
        orgId="org-1"
        viewerUserId="user-2"
      />
    )

    expect(await screen.findByText('boss@example.com')).toBeTruthy()
    expect(screen.getByText('peer@example.com')).toBeTruthy()
    // No management affordances.
    expect(screen.queryByPlaceholderText('teammate@example.com')).toBeNull()
    expect(screen.queryAllByLabelText('Role')).toHaveLength(0)
    expect(screen.queryAllByLabelText('Remove teammate')).toHaveLength(0)
  })
})
