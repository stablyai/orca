// @vitest-environment happy-dom
// OWNER-TRANSFER: the previous owner's notice stays until they close it (which tells the control
// plane); the new owner's shows once per hand-off.
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { CloudToastView } from '@/components/orca-cloud/cloud-toast-stack'
import type { OwnerChangeNotice } from '../../../../shared/cloud-workspaces/owner-change-wire'
import {
  rememberCloudWorkspaces,
  resetCloudWorkspaceIdentityForTests
} from './cloud-workspace-identity'
import { AUTH_STATUS, ROSTER, SELF_ID, workspace } from './cloud-workspaces.test-fixture'
import { OwnerChangeNotices } from './OwnerChangeNotices'
import { resetOwnerChangeNoticesForTests } from './owner-change-notices-store'

type Shown = { view: CloudToastView; onDismiss?: () => void }
const stack = vi.hoisted(() => ({ shown: new Map<string, Shown>() }))
vi.mock('@/components/orca-cloud/cloud-toast-stack', () => ({
  showCloudToast: (id: string, view: CloudToastView, options: { onDismiss?: () => void } = {}) =>
    void stack.shown.set(id, { view, onDismiss: options.onDismiss }),
  hideCloudToast: (id: string) => void stack.shown.delete(id)
}))

const NOTICE: OwnerChangeNotice = {
  id: 'otn_1',
  kind: 'workspace_owner_changed',
  workspace: { id: 'sbx_gone', name: 'Checkout retries', number: 12 },
  actor: { userId: 'user_grace', name: null },
  newOwner: { userId: 'user_linus', name: 'Linus Park' },
  at: 1
}

let notices: OwnerChangeNotice[]
const dismissOwnerNotice = vi.fn(() => Promise.resolve({ ok: true as const, value: undefined }))
const openSettingsTarget = vi.fn()
const openSettingsPage = vi.fn()

beforeEach(() => {
  notices = [NOTICE]
  stack.shown.clear()
  dismissOwnerNotice.mockClear()
  resetCloudWorkspaceIdentityForTests()
  resetOwnerChangeNoticesForTests()
  window.localStorage.clear()
  vi.stubGlobal('api', {
    cloudWorkspaces: {
      ownerNotices: () => Promise.resolve({ ok: true as const, value: notices }),
      dismissOwnerNotice
    },
    orcaProfiles: { orgMembersList: async () => ({ status: 'ok' as const, roster: ROSTER }) }
  })
  useAppStore.setState({ orcaProfileAuthStatus: AUTH_STATUS, openSettingsTarget, openSettingsPage })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  useAppStore.setState({ orcaProfileAuthStatus: null })
})

const line = (id: string) => stack.shown.get(id)?.view.lines[0]

describe('OwnerChangeNotices (OWNER-TRANSFER)', () => {
  it('tells a previous owner who gave their workspace away, naming people from the roster', async () => {
    render(<OwnerChangeNotices />)
    await waitFor(() =>
      expect(line('owner-change:otn_1')?.text).toBe(
        'Grace Hopper made Linus Park the owner of Checkout retries.'
      )
    )
    const shown = stack.shown.get('owner-change:otn_1')
    expect(shown?.view.priority).toBe('warning')
    expect(line('owner-change:otn_1')?.description).toBe(
      'Personal secrets you used in it may still be on its disk, so consider rotating them.'
    )
    expect(line('owner-change:otn_1')?.action?.label).toBe('Open Cloud secrets')
    line('owner-change:otn_1')?.action?.onClick()
    expect(openSettingsTarget).toHaveBeenCalledWith({ pane: 'cloud-secrets', repoId: null })
    // Opening the secrets does not close it: only the person does.
    expect(dismissOwnerNotice).not.toHaveBeenCalled()
  })

  it('closing it tells the control plane and takes it down', async () => {
    render(<OwnerChangeNotices />)
    await waitFor(() => expect(stack.shown.has('owner-change:otn_1')).toBe(true))
    act(() => stack.shown.get('owner-change:otn_1')?.onDismiss?.())
    expect(dismissOwnerNotice).toHaveBeenCalledWith('otn_1')
    await waitFor(() => expect(stack.shown.has('owner-change:otn_1')).toBe(false))
  })

  it('tells a new owner once that the workspace runs like a shared one', async () => {
    notices = []
    const handed = workspace({
      title: 'Docs search',
      ownerUserId: SELF_ID,
      createdBy: 'user_grace'
    })
    const transferredAt = handed.createdAt + 60_000
    render(<OwnerChangeNotices />)
    act(() => rememberCloudWorkspaces([{ ...handed, ownershipTransferredAt: transferredAt }]))
    const id = `new-owner:${handed.id}:${transferredAt}`
    await waitFor(() => expect(line(id)?.text).toBe('You’re now the owner of Docs search'))
    expect(stack.shown.get(id)?.view.priority).toBe('info')
    expect(line(id)?.action?.label).toBe('New workspace')
    act(() => stack.shown.get(id)?.onDismiss?.())
    await waitFor(() => expect(stack.shown.has(id)).toBe(false))
    // Still closed after the list is read again.
    act(() =>
      rememberCloudWorkspaces([
        { ...handed, title: 'Docs search 2', ownershipTransferredAt: transferredAt }
      ])
    )
    expect(stack.shown.has(id)).toBe(false)
  })

  it('shows nothing on a personal account', async () => {
    useAppStore.setState({
      orcaProfileAuthStatus: {
        ...AUTH_STATUS,
        cloud: AUTH_STATUS.cloud ? { ...AUTH_STATUS.cloud, activeOrgId: undefined } : undefined
      }
    })
    render(<OwnerChangeNotices />)
    await Promise.resolve()
    expect(stack.shown.size).toBe(0)
  })
})
