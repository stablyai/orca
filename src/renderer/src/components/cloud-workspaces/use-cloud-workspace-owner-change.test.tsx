// @vitest-environment happy-dom
// OWNER-TRANSFER: the confirmation makes the change itself, shows a refusal in place, and tells
// the person who made it whether the previous owner will hear about it.
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CloudWorkspace } from '../../../../shared/cloud-workspaces/cloud-workspaces-wire'
import type { OwnerChange } from '../../../../shared/cloud-workspaces/owner-change-wire'
import { CloudWorkspaceConfirmDialog } from './CloudWorkspaceConfirmDialog'
import {
  cloudWorkspaceIdentity,
  resetCloudWorkspaceIdentityForTests
} from './cloud-workspace-identity'
import { DIRECTORY, SELF_ID, workspace } from './cloud-workspaces.test-fixture'
import { newOwnerWorkspaces } from './owner-change-notices-store'
import { useCloudWorkspaceOwnerChange } from './use-cloud-workspace-owner-change'

const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
vi.mock('sonner', () => ({ toast: toasts }))

type Answer = { ok: true; value: OwnerChange } | { ok: false; error: string; reason?: string }

const THEIRS = workspace({ title: 'Checkout retries', ownerUserId: 'user_grace' })
const changeOwner = vi.fn<(id: string, ownerUserId: string) => Promise<Answer>>()
const ownerNotices = vi.fn(() => Promise.resolve({ ok: true as const, value: [] }))

function changed(to: string, previous: OwnerChange['previousOwner']): Answer {
  const next: CloudWorkspace = {
    ...THEIRS,
    ownerUserId: to,
    status: 'suspended',
    ownershipTransferredAt: THEIRS.createdAt + 60_000
  }
  return { ok: true, value: { workspace: next, previousOwner: previous } }
}

function hook(selfId: string | null = SELF_ID) {
  const replace = vi.fn()
  const refresh = vi.fn()
  const rendered = renderHook(() =>
    useCloudWorkspaceOwnerChange({ directory: DIRECTORY, selfId, replace, refresh })
  )
  return { ...rendered, replace, refresh }
}

beforeEach(() => {
  changeOwner.mockReset()
  toasts.success.mockReset()
  resetCloudWorkspaceIdentityForTests()
  window.localStorage.clear()
  vi.stubGlobal('api', { cloudWorkspaces: { changeOwner, ownerNotices } })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('useCloudWorkspaceOwnerChange (OWNER-TRANSFER)', () => {
  it('changes the owner and says the previous owner will see a notice', async () => {
    changeOwner.mockResolvedValue(
      changed('user_linus', { userId: 'user_grace', notified: true, inApp: true, emailed: false })
    )
    const { result, replace, refresh } = hook()
    let ok = false
    await act(async () => {
      ok = await result.current.run(THEIRS, 'user_linus')
    })
    expect(ok).toBe(true)
    expect(changeOwner).toHaveBeenCalledWith(THEIRS.id, 'user_linus')
    expect(replace).toHaveBeenCalledWith(expect.objectContaining({ ownerUserId: 'user_linus' }))
    expect(refresh).toHaveBeenCalled()
    expect(toasts.success).toHaveBeenCalledWith(
      'Owner changed',
      expect.objectContaining({
        description:
          'Grace Hopper will see a notice in Orca. If they used personal secrets in this workspace, they should rotate them.'
      })
    )
    // The chip follows at once.
    expect(cloudWorkspaceIdentity(THEIRS.id)?.ownershipTransferredAt).toBe(
      THEIRS.createdAt + 60_000
    )
  })

  it('says Orca cannot tell a previous owner who has left the team', async () => {
    changeOwner.mockResolvedValue(
      changed('user_linus', { userId: 'user_grace', notified: false, inApp: false, emailed: false })
    )
    const { result } = hook()
    await act(async () => {
      await result.current.run(THEIRS, 'user_linus')
    })
    expect(toasts.success.mock.calls[0]?.[1]?.description).toBe(
      'Grace Hopper has left the team, so Orca can’t tell them. If they used personal secrets in this workspace, ask them to rotate them.'
    )
  })

  it('taking a workspace yourself does not then tell you that you are the new owner', async () => {
    const answer = changed(SELF_ID, {
      userId: 'user_grace',
      notified: true,
      inApp: true,
      emailed: false
    })
    changeOwner.mockResolvedValue(answer)
    const { result } = hook()
    await act(async () => {
      await result.current.run(THEIRS, SELF_ID)
    })
    const taken = cloudWorkspaceIdentity(THEIRS.id)
    expect(taken?.ownerUserId).toBe(SELF_ID)
    expect(
      newOwnerWorkspaces(
        new Map(taken ? [[THEIRS.id, taken]] : []),
        SELF_ID,
        THEIRS.createdAt + 120_000,
        window.localStorage
      )
    ).toEqual([])
  })

  it('keeps a refusal in the hook for the confirmation, and changes nothing', async () => {
    changeOwner.mockResolvedValue({ ok: false, error: 'conflict', reason: 'stop_failed' })
    const { result, replace } = hook()
    let ok = true
    await act(async () => {
      ok = await result.current.run(THEIRS, 'user_linus')
    })
    expect(ok).toBe(false)
    expect(result.current.state).toEqual({
      busy: false,
      error: 'Couldn’t put this workspace to sleep, so the owner didn’t change. Try again.'
    })
    expect(replace).not.toHaveBeenCalled()
    expect(toasts.success).not.toHaveBeenCalled()
    act(() => result.current.reset())
    expect(result.current.state.error).toBeNull()
  })

  it('names the person in a membership refusal', async () => {
    changeOwner.mockResolvedValue({ ok: false, error: 'forbidden', reason: 'not_a_member' })
    const { result } = hook()
    await act(async () => {
      await result.current.run(THEIRS, 'user_linus')
    })
    expect(result.current.state.error).toBe('Linus Park isn’t a member of this team.')
  })

  it('after a timeout re-reads the list, since the change may still have landed', async () => {
    changeOwner.mockResolvedValue({ ok: false, error: 'timeout' })
    const { result, refresh } = hook()
    await act(async () => {
      await result.current.run(THEIRS, 'user_linus')
    })
    expect(refresh).toHaveBeenCalled()
    expect(result.current.state.error).not.toMatch(/nothing was changed/i)
  })
})

describe('Make owner confirmation (OWNER-TRANSFER)', () => {
  const dialog = (props: { busy?: boolean; error?: string | null; onConfirm?: () => void }) =>
    render(
      <CloudWorkspaceConfirmDialog
        pending={{
          kind: 'owner',
          workspace: workspace({ title: 'Docs search' }),
          ownerUserId: 'user_grace'
        }}
        directory={DIRECTORY}
        selfId={SELF_ID}
        canAdmin={false}
        onCancel={() => {}}
        onConfirm={props.onConfirm ?? (() => {})}
        busy={props.busy}
        error={props.error}
      />
    )

  it('says what the change does before it is made', () => {
    dialog({})
    expect(screen.getByText('Make Grace Hopper the owner?')).toBeTruthy()
    expect(screen.getByText('It goes to sleep now, and its share links stop working.')).toBeTruthy()
    expect(
      screen.getByText('Personal secrets you used in it may still be on its disk.')
    ).toBeTruthy()
    expect(screen.getByText(/You won't be able to manage this workspace after this\./)).toBeTruthy()
  })

  it('shows a refusal in place and lets the person try again', () => {
    const onConfirm = vi.fn()
    dialog({ error: 'Grace Hopper isn’t a member of this team.', onConfirm })
    expect(screen.getByRole('alert').textContent).toContain(
      'Grace Hopper isn’t a member of this team.'
    )
    fireEvent.click(screen.getByRole('button', { name: 'Make owner' }))
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })

  it('cannot be confirmed twice while the change is being made', () => {
    const onConfirm = vi.fn()
    dialog({ busy: true, onConfirm })
    fireEvent.click(screen.getByRole('button', { name: 'Changing owner…' }))
    expect(onConfirm).not.toHaveBeenCalled()
  })
})
