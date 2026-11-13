// @vitest-environment happy-dom
// Settings › Workspaces: the team's cloud workspaces as a table, filterable By / In / search, with
// only the actions the control plane allows an admin, through the same open, sleep and archive flows.
import { act, cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { CloudWorkspace } from '../../../../../shared/cloud-workspaces/cloud-workspaces-wire'
import { workspace } from '../../cloud-workspaces/cloud-workspaces.test-fixture'
import type * as OpenCloudWorkspaceNs from '../../cloud-workspaces/open-cloud-workspace'
import type * as ArchiveNs from '../../cloud-workspaces/cloud-workspace-home-archive'

type OpenModule = typeof OpenCloudWorkspaceNs
type ArchiveModule = typeof ArchiveNs

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
  return { state, open: vi.fn(), sleep: vi.fn(), archive: vi.fn() }
})

vi.mock('@/store', () => ({
  useAppStore: Object.assign(
    (selector: (s: typeof mocks.state) => unknown) => selector(mocks.state),
    { getState: () => mocks.state, subscribe: () => () => {} }
  )
}))
vi.mock('../../billing/team/use-org-roster', async () => {
  const { ROSTER } = await import('../../cloud-workspaces/cloud-workspaces.test-fixture')
  const result = { status: 'ok' as const, roster: ROSTER }
  return { useOrgRoster: () => ({ result }) }
})
vi.mock('../../cloud-workspaces/open-cloud-workspace', async (importOriginal) => ({
  ...(await importOriginal<OpenModule>()),
  openCloudWorkspace: mocks.open
}))
vi.mock('../../cloud-workspaces/cloud-workspace-home-archive', async (importOriginal) => ({
  ...(await importOriginal<ArchiveModule>()),
  homeArchiveActions: () => ({
    sleep: mocks.sleep,
    archive: mocks.archive,
    unarchive: vi.fn(),
    remove: vi.fn(),
    restart: vi.fn()
  })
}))

import { TeamWorkspacesSettings } from './TeamWorkspacesSettings'

const RUNNING = workspace({
  title: 'Refund webhooks',
  repo: { url: 'https://github.com/acme/web.git', branch: 'refunds' },
  ownerUserId: 'user_grace',
  createdBy: 'user_grace',
  access: 'can_open',
  lastActivityAt: Date.now() - 60_000
})
const ARCHIVED = workspace({
  title: 'Old spike',
  ownerUserId: 'user_linus',
  createdBy: 'user_linus',
  access: 'can_open',
  archivedAt: 1,
  status: 'suspended',
  lastActivityAt: Date.now() - 86_400_000
})
const PRIVATE = workspace({
  title: 'Ada’s private notes',
  visibility: 'private',
  status: 'suspended',
  lastActivityAt: Date.now() - 3_600_000
})

let list: CloudWorkspace[]

beforeEach(() => {
  list = [RUNNING, ARCHIVED, PRIVATE]
  mocks.open.mockReset().mockResolvedValue({ ok: true, worktreeId: 'wt-1' })
  mocks.sleep.mockReset()
  mocks.archive.mockReset()
  vi.stubGlobal('api', {
    cloudWorkspaces: {
      available: () => Promise.resolve(true),
      list: vi.fn((query: unknown) => {
        expect(query).toEqual({ scope: 'team', archived: 'include' })
        return Promise.resolve({ ok: true, value: list })
      })
    }
  })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

async function renderPane(): Promise<void> {
  render(
    <TooltipProvider>
      <TeamWorkspacesSettings orgId="org_acme" />
    </TooltipProvider>
  )
  await screen.findByText('Refund webhooks')
}

const row = (title: string): HTMLElement => screen.getByText(title).closest('tr')!

describe('Settings › Workspaces', () => {
  it('lists every team workspace with who started it, its state, W-number and access', async () => {
    await renderPane()
    const refund = within(row('Refund webhooks'))
    expect(refund.getByText('Grace Hopper')).toBeTruthy()
    expect(refund.getByText('Running')).toBeTruthy()
    expect(refund.getByText(`W-${RUNNING.number}`)).toBeTruthy()
    expect(refund.getByText('Shared')).toBeTruthy()
    expect(refund.getByText('acme/web · refunds')).toBeTruthy()
    expect(within(row('Old spike')).getByText('Archived')).toBeTruthy()
    expect(within(row('Ada’s private notes')).getByText('Private')).toBeTruthy()
    expect(screen.getByText('3 of 3 workspaces')).toBeTruthy()
  })

  it('search narrows the table', async () => {
    const user = userEvent.setup()
    await renderPane()
    await user.type(screen.getByRole('searchbox', { name: 'Search workspaces' }), 'grace')
    expect(screen.queryByText('Old spike')).toBeNull()
    expect(screen.getByText('1 of 3 workspaces')).toBeTruthy()
  })

  it('a running teammate workspace offers Open, Sleep and Archive; Open uses openCloudWorkspace', async () => {
    const user = userEvent.setup()
    await renderPane()
    await user.click(
      within(row('Refund webhooks')).getByRole('button', { name: 'Actions for Refund webhooks' })
    )
    const items = (await screen.findAllByRole('menuitem')).map((item) => item.textContent)
    expect(items).toEqual(['Open', 'Sleep', 'Archive'])
    await user.click(screen.getByRole('menuitem', { name: 'Open' }))
    expect(mocks.open).toHaveBeenCalledWith(RUNNING)
  })

  it('Sleep and Archive go through the shared archive flows', async () => {
    const user = userEvent.setup()
    await renderPane()
    const menu = (): HTMLElement =>
      within(row('Refund webhooks')).getByRole('button', { name: 'Actions for Refund webhooks' })
    await user.click(menu())
    await user.click(await screen.findByRole('menuitem', { name: 'Sleep' }))
    expect(mocks.sleep).toHaveBeenCalledWith(RUNNING)
    await user.click(menu())
    await user.click(await screen.findByRole('menuitem', { name: 'Archive' }))
    expect(mocks.archive).toHaveBeenCalledWith(RUNNING)
  })

  it('an archived workspace has no actions to offer', async () => {
    await renderPane()
    expect(within(row('Old spike')).queryByRole('button')).toBeNull()
  })

  it('an empty team says so', async () => {
    list = []
    render(<TeamWorkspacesSettings orgId="org_acme" />)
    expect(await screen.findByText('No one on your team has a cloud workspace yet.')).toBeTruthy()
    await act(async () => {})
  })
})
