// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OrcaProfileOrgMembersDialog } from './OrcaProfileOrgMembersDialog'

const orgMemberInvite = vi.fn(async () => ({ status: 'ok' }) as const)

beforeEach(() => {
  orgMemberInvite.mockClear()
  ;(window as unknown as { api: unknown }).api = {
    orcaProfiles: {
      orgMembersList: vi.fn(async () => ({
        status: 'ok' as const,
        roster: { canManageMembers: true, members: [], pendingInvites: [] }
      })),
      orgMemberInvite,
      orgMemberChangeRole: vi.fn(),
      orgMemberRemove: vi.fn(),
      orgInviteRevoke: vi.fn()
    }
  }
})

afterEach(cleanup)

function dispatchKey(el: HTMLElement, type: 'keydown' | 'keyup', init: KeyboardEventInit): boolean {
  const event = new KeyboardEvent(type, { bubbles: true, cancelable: true, ...init })
  Object.defineProperty(event, 'keyCode', { value: init.keyCode })
  act(() => {
    el.dispatchEvent(event)
  })
  return event.defaultPrevented
}

async function renderInviteInput(): Promise<HTMLInputElement> {
  const view = render(
    <OrcaProfileOrgMembersDialog open onOpenChange={vi.fn()} orgId="org-1" orgName="Org" />
  )
  const input = await waitFor(() => {
    const el = document.getElementById('orca-org-invite-email')
    if (!el) {
      throw new Error('invite input not found')
    }
    return el as HTMLInputElement
  })
  void view
  fireEvent.change(input, { target: { value: 'teammate@example.com' } })
  return input
}

// Why: the invite submits through the form's NATIVE implicit submission, which happy-dom does
// not simulate — so these assert the guard's real contract, that it suppresses the default
// action on an IME-owned Enter and leaves an ordinary Enter alone.
describe('OrcaProfileOrgMembersDialog invite IME Enter ownership', () => {
  it('suppresses the default action on the recorded Korean Enter redispatch', async () => {
    const input = await renderInviteInput()

    fireEvent.compositionStart(input)
    dispatchKey(input, 'keydown', { key: 'Process', keyCode: 229, isComposing: true })
    fireEvent.compositionEnd(input, { data: '\uac00' })
    const prevented = dispatchKey(input, 'keydown', {
      key: 'Enter',
      keyCode: 13,
      isComposing: false
    })

    expect(prevented).toBe(true)
    expect(orgMemberInvite).not.toHaveBeenCalled()
  })

  it('suppresses the default action on the marked confirm keydown', async () => {
    const input = await renderInviteInput()

    fireEvent.compositionStart(input)
    const prevented = dispatchKey(input, 'keydown', {
      key: 'Process',
      keyCode: 229,
      isComposing: true
    })

    expect(prevented).toBe(true)
  })

  it('leaves an ordinary Enter free to submit the form natively', async () => {
    const input = await renderInviteInput()

    const prevented = dispatchKey(input, 'keydown', {
      key: 'Enter',
      keyCode: 13,
      isComposing: false
    })

    expect(prevented).toBe(false)
  })
})
