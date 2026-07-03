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
      repo: 'orca'
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
      seedLogins: ['jinwoo']
    })
    expect(renders).toBeLessThanOrEqual(4)
  })
})
