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

describe('SSH config picker host selection', () => {
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
})
