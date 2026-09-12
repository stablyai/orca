// @vitest-environment happy-dom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SshConfigHostResolution } from '../../../../shared/ssh-types'

const toastMocks = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }))
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), toastMocks) }))

const storeActions = vi.hoisted(() => ({
  setSshTargetsMetadata: vi.fn(),
  recordSshRepoReadoptions: vi.fn(),
  setRuntimeEnvironments: vi.fn(),
  setRuntimeEnvironmentStatus: vi.fn(),
  recordFeatureInteraction: vi.fn()
}))
vi.mock('@/store', () => ({
  useAppStore: (selector: (state: unknown) => unknown) => selector(storeActions)
}))

import { AddRemoteHostDialog } from './AddRemoteHostDialog'

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

function resolution(alias: string, hostname: string): SshConfigHostResolution {
  return {
    alias,
    hostname,
    port: 22,
    username: 'deploy',
    identityFiles: [],
    identitiesOnly: false,
    forwardAgent: false,
    proxyUseFdpass: false
  }
}

const listConfigHosts = vi.fn()
const resolveConfigHost = vi.fn()
const importConfig = vi.fn()
const listTargets = vi.fn()

function configHost(
  alias: string,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    alias,
    hostname: `${alias}.internal`,
    port: 22,
    username: 'deploy',
    alreadyInOrca: false,
    ...overrides
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  listConfigHosts.mockResolvedValue({
    hosts: [configHost('alpha'), configHost('bravo')],
    totalHostCount: 2,
    newHostCount: 2,
    matchCount: 2,
    hasMore: false
  })
  importConfig.mockResolvedValue({ targets: [], repoReadoptions: [] })
  listTargets.mockResolvedValue([])
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { ssh: { listConfigHosts, resolveConfigHost, importConfig, listTargets } }
  })
})

afterEach(() => {
  cleanup()
})

async function openPicker(): Promise<ReturnType<typeof userEvent.setup>> {
  const user = userEvent.setup()
  render(<AddRemoteHostDialog mode="ssh" onOpenChange={vi.fn()} />)
  await user.click(screen.getByRole('button', { name: /Fill from/ }))
  await screen.findByRole('button', { name: /alpha/ })
  return user
}

async function openPickerWith(result: Record<string, unknown>): Promise<void> {
  listConfigHosts.mockResolvedValue({ hasMore: false, ...result })
  const user = userEvent.setup()
  render(<AddRemoteHostDialog mode="ssh" onOpenChange={vi.fn()} />)
  await user.click(screen.getByRole('button', { name: /Fill from/ }))
}

describe('SSH config picker host selection', () => {
  it('drops a resolve that lands after the user backs out of the picker', async () => {
    const pending = deferred<SshConfigHostResolution>()
    resolveConfigHost.mockReturnValueOnce(pending.promise)
    const user = await openPicker()

    await user.click(screen.getByRole('button', { name: /alpha/ }))
    await user.click(screen.getByRole('button', { name: 'Back' }))
    pending.resolve(resolution('alpha', 'alpha.internal'))
    await waitFor(() => expect(screen.getByLabelText('Host or alias')).toBeDefined())

    expect((screen.getByLabelText('Host or alias') as HTMLInputElement).value).toBe('')
    expect(toastMocks.success).not.toHaveBeenCalled()
  })

  it('keeps the host the user settled on when an earlier resolve lands late', async () => {
    const slowAlpha = deferred<SshConfigHostResolution>()
    resolveConfigHost.mockReturnValueOnce(slowAlpha.promise)
    resolveConfigHost.mockResolvedValueOnce(resolution('bravo', 'bravo.internal'))
    const user = await openPicker()

    await user.click(screen.getByRole('button', { name: /alpha/ }))
    await user.click(screen.getByRole('button', { name: 'Back' }))
    await user.click(screen.getByRole('button', { name: /Fill from/ }))
    await user.click(await screen.findByRole('button', { name: /bravo/ }))
    await waitFor(() =>
      expect((screen.getByLabelText('Host or alias') as HTMLInputElement).value).toBe(
        'bravo.internal'
      )
    )

    await act(async () => {
      slowAlpha.resolve(resolution('alpha', 'alpha.internal'))
      await slowAlpha.promise
    })

    expect((screen.getByLabelText('Host or alias') as HTMLInputElement).value).toBe(
      'bravo.internal'
    )
  })

  it('freezes the other rows while a pick is resolving', async () => {
    const pending = deferred<SshConfigHostResolution>()
    resolveConfigHost.mockReturnValueOnce(pending.promise)
    const user = await openPicker()

    await user.click(screen.getByRole('button', { name: /alpha/ }))

    await waitFor(() =>
      expect(screen.getByRole('button', { name: /bravo/ }).hasAttribute('disabled')).toBe(true)
    )
    await act(async () => {
      pending.resolve(resolution('alpha', 'alpha.internal'))
      await pending.promise
    })
  })
})

describe('SSH config picker tombstoned hosts', () => {
  it('keeps a previously removed host pickable while an adopted one stays disabled', async () => {
    await openPickerWith({
      hosts: [
        configHost('removed', { previouslyRemoved: true }),
        configHost('kept', { alreadyInOrca: true })
      ],
      totalHostCount: 2,
      newHostCount: 0,
      matchCount: 2
    })

    const removed = await screen.findByRole('button', { name: /removed/ })
    expect(removed.hasAttribute('disabled')).toBe(false)
    expect(removed.textContent).toContain('Removed from Orca')

    const kept = screen.getByRole('button', { name: /kept/ })
    expect(kept.hasAttribute('disabled')).toBe(true)
    expect(kept.textContent).toContain('In Orca')
  })

  it('never claims the config is empty when every host is only tombstoned', async () => {
    await openPickerWith({
      hosts: [configHost('removed', { previouslyRemoved: true })],
      totalHostCount: 1,
      newHostCount: 0,
      matchCount: 1
    })

    const addAll = await screen.findByRole('button', { name: 'No new hosts to add' })
    expect(addAll.hasAttribute('disabled')).toBe(true)
    expect(screen.queryByText('No hosts in ~/.ssh/config')).toBeNull()
  })

  it('still shows the empty state when the config really has no hosts', async () => {
    await openPickerWith({ hosts: [], totalHostCount: 0, newHostCount: 0, matchCount: 0 })

    expect(await screen.findByText('No hosts in ~/.ssh/config')).toBeDefined()
    expect(screen.getByRole('button', { name: 'Add all to Orca' }).hasAttribute('disabled')).toBe(
      true
    )
  })
})

describe('SSH config picker bulk add', () => {
  it('adds only new hosts and never re-adopts deleted aliases', async () => {
    const user = await openPicker()

    await user.click(screen.getByRole('button', { name: /Add all 2 to Orca/ }))

    await waitFor(() => expect(importConfig).toHaveBeenCalled())
    expect(importConfig).toHaveBeenCalledWith()
    expect(importConfig.mock.calls[0][0]).toBeUndefined()
  })
})
