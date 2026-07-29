// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearGitHubSlugMetadataCache,
  useRepoAssigneesBySlug,
  useRepoLabelsBySlug
} from './useGitHubSlugMetadata'

const apiMocks = vi.hoisted(() => ({
  listLabelsBySlug: vi.fn(),
  listAssignableUsersBySlug: vi.fn()
}))

vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: vi.fn(),
  getActiveRuntimeTarget: (settings?: { activeRuntimeEnvironmentId?: string | null } | null) =>
    settings?.activeRuntimeEnvironmentId
      ? { kind: 'environment', environmentId: settings.activeRuntimeEnvironmentId }
      : { kind: 'local' }
}))

const roots: Root[] = []

function installWindowApi(): void {
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      gh: {
        listLabelsBySlug: apiMocks.listLabelsBySlug,
        listAssignableUsersBySlug: apiMocks.listAssignableUsersBySlug
      }
    }
  })
}

async function flushEffects(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

function renderProbe(element: React.ReactNode): void {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  act(() => {
    root.render(element)
  })
}

describe('useGitHubSlugMetadata', () => {
  beforeEach(() => {
    clearGitHubSlugMetadataCache()
    apiMocks.listLabelsBySlug.mockReset()
    apiMocks.listAssignableUsersBySlug.mockReset()
    installWindowApi()
  })

  afterEach(() => {
    roots.splice(0).forEach((root) => {
      act(() => root.unmount())
    })
    document.body.replaceChildren()
    vi.unstubAllGlobals()
  })

  it('does not loop when cached label metadata is read with a fresh settings object', async () => {
    let renders = 0
    let labels: string[] = []
    apiMocks.listLabelsBySlug.mockResolvedValue({ ok: true, labels: ['bug'] })

    function LabelsProbe(): null {
      renders += 1
      const metadata = useRepoLabelsBySlug('stablyai', 'orca', {
        activeRuntimeEnvironmentId: null
      })
      labels = metadata.data
      return null
    }

    renderProbe(<LabelsProbe />)
    await flushEffects()

    expect(labels).toEqual(['bug'])
    expect(apiMocks.listLabelsBySlug).toHaveBeenCalledExactlyOnceWith({
      owner: 'stablyai',
      repo: 'orca',
      host: 'github.com'
    })
    expect(renders).toBeLessThanOrEqual(4)
  })

  it('does not loop when cached assignee metadata is read with a fresh settings object', async () => {
    let renders = 0
    let assigneeLogins: string[] = []
    apiMocks.listAssignableUsersBySlug.mockResolvedValue({
      ok: true,
      users: [{ login: 'jinwoo', name: 'Jinwoo', avatarUrl: 'https://example.test/avatar.png' }]
    })

    function AssigneesProbe(): null {
      renders += 1
      const metadata = useRepoAssigneesBySlug('stablyai', 'orca', ['jinwoo'], {
        activeRuntimeEnvironmentId: null
      })
      assigneeLogins = metadata.data.map((user) => user.login)
      return null
    }

    renderProbe(<AssigneesProbe />)
    await flushEffects()

    expect(assigneeLogins).toEqual(['jinwoo'])
    expect(apiMocks.listAssignableUsersBySlug).toHaveBeenCalledExactlyOnceWith({
      owner: 'stablyai',
      repo: 'orca',
      host: 'github.com',
      seedLogins: ['jinwoo']
    })
    expect(renders).toBeLessThanOrEqual(4)
  })

  it('does not re-issue a failed label fetch when a fresh settings object re-renders', async () => {
    // Regression: with an unreachable provider, the failure setState re-rendered
    // the consumer, the fresh settings identity re-armed the effect, and the hook
    // re-issued the fetch each settlement — a render-paced request storm.
    let renders = 0
    let error: string | null = null
    apiMocks.listLabelsBySlug.mockRejectedValue(new Error('Could not connect'))

    function FailingLabelsProbe(): null {
      renders += 1
      const metadata = useRepoLabelsBySlug('stablyai', 'orca', {
        activeRuntimeEnvironmentId: null
      })
      error = metadata.error
      return null
    }

    renderProbe(<FailingLabelsProbe />)
    await flushEffects()
    // Extra settlement rounds give a storm the chance to manifest.
    await flushEffects()
    await flushEffects()

    expect(error).toBe('Could not connect')
    expect(apiMocks.listLabelsBySlug).toHaveBeenCalledTimes(1)
    expect(renders).toBeLessThanOrEqual(4)
  })

  it('preserves an enterprise host on slug metadata reads', async () => {
    apiMocks.listLabelsBySlug.mockResolvedValue({ ok: true, labels: ['enterprise'] })

    function LabelsProbe(): null {
      useRepoLabelsBySlug(
        'stablyai',
        'orca',
        { activeRuntimeEnvironmentId: null },
        'ghe.example.com'
      )
      return null
    }

    renderProbe(<LabelsProbe />)
    await flushEffects()

    expect(apiMocks.listLabelsBySlug).toHaveBeenCalledExactlyOnceWith({
      owner: 'stablyai',
      repo: 'orca',
      host: 'ghe.example.com'
    })
  })

  it('does not re-issue a failed assignee fetch when a fresh settings object re-renders', async () => {
    let renders = 0
    let error: string | null = null
    apiMocks.listAssignableUsersBySlug.mockRejectedValue(new Error('Could not connect'))

    function FailingAssigneesProbe(): null {
      renders += 1
      const metadata = useRepoAssigneesBySlug('stablyai', 'orca', ['jinwoo'], {
        activeRuntimeEnvironmentId: null
      })
      error = metadata.error
      return null
    }

    renderProbe(<FailingAssigneesProbe />)
    await flushEffects()
    await flushEffects()
    await flushEffects()

    expect(error).toBe('Could not connect')
    expect(apiMocks.listAssignableUsersBySlug).toHaveBeenCalledTimes(1)
    expect(renders).toBeLessThanOrEqual(4)
  })
})
