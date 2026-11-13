// @vitest-environment happy-dom
// "Open cloud workspace…": lists what the sidebar doesn't show, opens through openCloudWorkspace,
// and is what every former Home pointer opens now.
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { CloudWorkspace } from '../../../../shared/cloud-workspaces/cloud-workspaces-wire'
import { workspace } from './cloud-workspaces.test-fixture'
import type * as OpenCloudWorkspaceNs from './open-cloud-workspace'

type OpenCloudWorkspaceModule = typeof OpenCloudWorkspaceNs

const mocks = vi.hoisted(() => {
  const state = {
    orcaProfileAuthStatus: {
      activeProfileId: 'profile-1',
      configured: true,
      state: 'connected',
      persistence: 'encrypted',
      cloud: { userId: 'user_ada', activeOrgId: 'org_acme', activeOrgName: 'Acme' }
    },
    connectCurrentOrcaProfile: async () => {},
    keybindings: {},
    ephemeralVmRuntimesByWorkspaceId: {}
  }
  return {
    state,
    openCloudWorkspace: vi.fn(),
    inSidebar: new Set<string>()
  }
})

vi.mock('@/store', () => ({
  useAppStore: Object.assign(
    (selector: (s: typeof mocks.state) => unknown) => selector(mocks.state),
    { getState: () => mocks.state, subscribe: () => () => {} }
  )
}))
vi.mock('../billing/team/use-org-roster', async () => {
  const { ROSTER } = await import('./cloud-workspaces.test-fixture')
  const result = { status: 'ok' as const, roster: ROSTER }
  return { useOrgRoster: () => ({ result }) }
})
vi.mock('../new-workspace/run-on/OrcaCloudTrialUsedUpNotice', () => ({
  OrcaCloudTrialUsedUpBanner: () => null
}))
vi.mock('./cloud-workspaces-in-sidebar', () => ({
  useCloudWorkspaceIdsInSidebar: () => mocks.inSidebar
}))
vi.mock('./open-cloud-workspace', async (importOriginal) => ({
  ...(await importOriginal<OpenCloudWorkspaceModule>()),
  openCloudWorkspace: mocks.openCloudWorkspace
}))

import { CloudWorkspacePickerDialog } from './CloudWorkspacePicker'
import {
  closeCloudWorkspacePicker,
  getCloudWorkspacePickerRequest,
  openCloudWorkspacePicker
} from './cloud-workspace-picker-store'
import { CloudNotPairedCard } from '../orca-cloud/CloudNotPairedCard'

type ListResult = { ok: true; value: CloudWorkspace[] } | { ok: false; error: string }
let listResult: ListResult

const MINE = workspace({ title: 'Already in my sidebar' })
const SHARED = workspace({
  title: 'Refund webhooks',
  ownerUserId: 'user_grace',
  createdBy: 'user_grace',
  access: 'can_open'
})

beforeEach(() => {
  mocks.inSidebar = new Set([MINE.id])
  mocks.openCloudWorkspace.mockReset()
  listResult = { ok: true, value: [MINE, SHARED] }
  vi.stubGlobal('api', {
    cloudWorkspaces: {
      available: () => Promise.resolve(true),
      list: vi.fn(() => Promise.resolve(listResult))
    }
  })
})

afterEach(() => {
  act(() => closeCloudWorkspacePicker())
  cleanup()
  vi.unstubAllGlobals()
})

function renderPicker(): void {
  render(
    <TooltipProvider>
      <CloudWorkspacePickerDialog />
    </TooltipProvider>
  )
}

describe('Open cloud workspace…', () => {
  it('lists a teammate’s shared workspace and leaves out what the sidebar already shows', async () => {
    renderPicker()
    act(() => openCloudWorkspacePicker())
    expect(await screen.findByText('Refund webhooks')).toBeTruthy()
    expect(screen.queryByText('Already in my sidebar')).toBeNull()
    expect(screen.getByText('1 more is already in your sidebar.')).toBeTruthy()
  })

  it('opens through openCloudWorkspace, then closes', async () => {
    mocks.openCloudWorkspace.mockResolvedValue({ ok: true, worktreeId: 'wt-1' })
    renderPicker()
    act(() => openCloudWorkspacePicker())
    fireEvent.click(await screen.findByRole('button', { name: /^Refund webhooks, Running/ }))
    await waitFor(() => expect(getCloudWorkspacePickerRequest()).toBeNull())
    expect(mocks.openCloudWorkspace).toHaveBeenCalledWith(SHARED)
  })

  it('a failed open stays open (the error is a toast), so another can be picked', async () => {
    mocks.openCloudWorkspace.mockResolvedValue({ ok: false, message: 'No access' })
    renderPicker()
    act(() => openCloudWorkspacePicker())
    fireEvent.click(await screen.findByRole('button', { name: /^Refund webhooks, Running/ }))
    await waitFor(() => expect(mocks.openCloudWorkspace).toHaveBeenCalled())
    expect(getCloudWorkspacePickerRequest()).not.toBeNull()
  })

  it('with everything in the sidebar, says so instead of inviting a first workspace', async () => {
    listResult = { ok: true, value: [MINE] }
    renderPicker()
    act(() => openCloudWorkspacePicker())
    expect(await screen.findByText('Your cloud workspaces are already in the sidebar')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'New cloud workspace' })).toBeNull()
  })

  it('a list that could not be read offers Try again', async () => {
    listResult = { ok: false, error: 'unavailable' }
    renderPicker()
    act(() => openCloudWorkspacePicker())
    expect(await screen.findByRole('button', { name: 'Try again' })).toBeTruthy()
  })

  it('a teammate focus lists their workspaces, sidebar ones included', async () => {
    mocks.inSidebar = new Set([SHARED.id])
    renderPicker()
    act(() => openCloudWorkspacePicker({ kind: 'teammate', userId: 'user_grace' }))
    expect(await screen.findByText('Refund webhooks')).toBeTruthy()
    expect(screen.getByText('Grace Hopper’s cloud workspaces')).toBeTruthy()
    expect(screen.queryByText('Already in my sidebar')).toBeNull()
  })
})

describe('pointers that used to send people to Home', () => {
  it('a workspace whose pairing is gone offers Open cloud workspace…, not a text pointer', () => {
    const onDismiss = vi.fn()
    render(<CloudNotPairedCard name="Refund webhooks" onDismiss={onDismiss} />)
    expect(screen.getByText('Refund webhooks isn’t linked to this computer')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Open cloud workspace…' }))
    expect(getCloudWorkspacePickerRequest()?.focus).toEqual({ kind: 'open' })
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })
})
