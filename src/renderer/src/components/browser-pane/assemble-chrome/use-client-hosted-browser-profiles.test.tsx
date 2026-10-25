import { replaceRuntimeEnvironmentRevisions } from '@/runtime/runtime-environment-revision'
// @vitest-environment happy-dom
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor
} from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'

const rpc = vi.hoisted(() => vi.fn())
vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: rpc }))
import { useClientHostedBrowserProfiles } from './use-client-hosted-browser-profiles'

afterEach(cleanup)
beforeEach(() => {
  rpc.mockReset()
  replaceRuntimeEnvironmentRevisions([{ id: 'runtime-a', createdAt: 7, pairingRevision: 7 }])
})
afterEach(() => {
  replaceRuntimeEnvironmentRevisions([])
})

function Harness() {
  const profiles = useClientHostedBrowserProfiles('runtime-a', 'host-page')
  return (
    <>
      <button onClick={() => void profiles.load()}>Load</button>
      <DropdownMenu open modal={false}>
        <DropdownMenuTrigger asChild>
          <button>Menu</button>
        </DropdownMenuTrigger>
        <DropdownMenuContent>{profiles.items}</DropdownMenuContent>
      </DropdownMenu>
      {profiles.dialog}
    </>
  )
}

function mockProfiles(switchResult: () => Promise<unknown> = async () => ({})) {
  rpc.mockImplementation(async (_target, method) => {
    if (method === 'browser.profileList') {
      return {
        profiles: [
          { id: 'default', label: 'Default' },
          { id: 'remote-profile', label: 'Remote profile' }
        ]
      }
    }
    if (method === 'browser.tabSetProfile') {
      return switchResult()
    }
    return {
      tabs: [
        { browserPageId: 'other-page', profileId: 'remote-profile' },
        { browserPageId: 'host-page', profileId: 'default' }
      ]
    }
  })
}

async function selectProfile() {
  fireEvent.click(screen.getByRole('button', { name: 'Load' }))
  fireEvent.click(await screen.findByRole('menuitemradio', { name: 'Remote profile' }))
  await screen.findByRole('dialog')
}

describe('client-hosted profile reads', () => {
  it('reads metadata and selection from the explicit runtime and authoritative page', async () => {
    mockProfiles()
    const { result } = renderHook(() => useClientHostedBrowserProfiles('runtime-a', 'host-page'))
    await act(async () => {
      await result.current.load()
    })
    expect(rpc.mock.calls).toEqual([
      [
        { kind: 'environment', environmentId: 'runtime-a' },
        'browser.profileList',
        undefined,
        { expectedEnvironmentPairingRevision: 7 }
      ],
      [
        { kind: 'environment', environmentId: 'runtime-a' },
        'browser.tabList',
        undefined,
        { expectedEnvironmentPairingRevision: 7 }
      ]
    ])
  })

  it('does not fall back locally while the host placement is missing', async () => {
    const { result } = renderHook(() => useClientHostedBrowserProfiles('runtime-a', null))
    await act(async () => {
      await result.current.load()
    })
    expect(rpc).not.toHaveBeenCalled()
  })

  it('handles failed reads without mutation', async () => {
    rpc.mockRejectedValue(new Error('Host unavailable'))
    const { result } = renderHook(() => useClientHostedBrowserProfiles('runtime-a', 'host-page'))
    await act(async () => {
      await result.current.load()
    })
    expect(rpc).toHaveBeenCalledTimes(2)
    expect(rpc.mock.calls.every((call) => call[1] !== 'browser.tabSetProfile')).toBe(true)
  })
})

describe('client-hosted profile confirmation', () => {
  it('cancels without issuing any profile switch', async () => {
    mockProfiles()
    render(<Harness />)
    await selectProfile()
    expect(rpc.mock.calls.some((call) => call[1] === 'browser.tabSetProfile')).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(rpc.mock.calls.some((call) => call[1] === 'browser.tabSetProfile')).toBe(false)
  })

  it('sends only one confirmed switch to the runtime, then re-reads authoritative state', async () => {
    let finish!: (value: unknown) => void
    mockProfiles(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    render(<Harness />)
    await selectProfile()
    const confirm = screen.getByRole('button', { name: /^Switch$/ })
    fireEvent.click(confirm)
    fireEvent.click(confirm)
    expect(rpc.mock.calls.filter((call) => call[1] === 'browser.tabSetProfile')).toEqual([
      [
        { kind: 'environment', environmentId: 'runtime-a' },
        'browser.tabSetProfile',
        { page: 'host-page', profileId: 'remote-profile' },
        { expectedEnvironmentPairingRevision: 7 }
      ]
    ])
    await act(async () => {
      finish({ profileId: 'remote-profile' })
    })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(rpc.mock.calls.filter((call) => call[1] === 'browser.tabList')).toHaveLength(2)
  })

  it('keeps a failed switch visible and does not issue a compensating rollback', async () => {
    mockProfiles(async () => {
      throw new Error('Host switch refused')
    })
    render(<Harness />)
    await selectProfile()
    fireEvent.click(screen.getByRole('button', { name: /^Switch$/ }))
    expect((await screen.findByRole('alert')).textContent).toContain('Host switch refused')
    expect(screen.getByRole('dialog')).not.toBeNull()
    expect(rpc.mock.calls.filter((call) => call[1] === 'browser.tabSetProfile')).toHaveLength(1)
  })
})

describe('profile request ownership', () => {
  it('ignores an older profile-list response after a newer read settles', async () => {
    let finishOld!: (value: unknown) => void
    let lists = 0
    rpc.mockImplementation(async (_target, method) => {
      if (method === 'browser.profileList') {
        lists += 1
        if (lists === 1) {
          return new Promise((resolve) => {
            finishOld = resolve
          })
        }
        return { profiles: [{ id: 'fresh', label: 'Fresh host profile' }] }
      }
      return { tabs: [{ browserPageId: 'host-page', profileId: 'fresh' }] }
    })
    render(<Harness />)
    fireEvent.click(screen.getByRole('button', { name: 'Load' }))
    fireEvent.click(screen.getByRole('button', { name: 'Load' }))
    await screen.findByRole('menuitemradio', { name: 'Fresh host profile' })
    await act(async () => {
      finishOld({ profiles: [{ id: 'stale', label: 'Stale host profile' }] })
    })
    expect(screen.queryByRole('menuitemradio', { name: 'Stale host profile' })).toBeNull()
    expect(screen.getByRole('menuitemradio', { name: 'Fresh host profile' })).not.toBeNull()
  })

  it('does not roll back or read through an unmounted UI when host success arrives late', async () => {
    let finish!: (value: unknown) => void
    mockProfiles(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    const view = render(<Harness />)
    await selectProfile()
    fireEvent.click(screen.getByRole('button', { name: /^Switch$/ }))
    view.unmount()
    await act(async () => {
      finish({ profileId: 'remote-profile' })
    })
    expect(rpc.mock.calls.filter((call) => call[1] === 'browser.tabSetProfile')).toHaveLength(1)
    expect(rpc.mock.calls.filter((call) => call[1] === 'browser.tabList')).toHaveLength(1)
  })
})

it('fences confirmation to the pairing that supplied the selected profile', async () => {
  mockProfiles()
  render(<Harness />)
  await selectProfile()
  replaceRuntimeEnvironmentRevisions([{ id: 'runtime-a', createdAt: 8, pairingRevision: 8 }], {
    retired: ['runtime-a'],
    sameHost: []
  })
  fireEvent.click(screen.getByRole('button', { name: /^Switch$/ }))
  await waitFor(() =>
    expect(rpc.mock.calls.filter((call) => call[1] === 'browser.tabSetProfile')).toHaveLength(1)
  )
  expect(rpc.mock.calls.find((call) => call[1] === 'browser.tabSetProfile')?.[3]).toEqual({
    expectedEnvironmentPairingRevision: 7
  })
})
