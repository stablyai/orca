// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../shared/types'
import { RepositoryIconPicker } from './RepositoryIconPicker'

vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: vi.fn(),
  getActiveRuntimeTarget: () => ({ kind: 'local' })
}))

vi.mock('./RepositoryIconColorSection', () => ({
  RepositoryIconColorSection: () => null
}))

vi.mock('./RepositoryIconTabs', () => ({
  RepositoryIconTabs: () => null
}))

const apiMocks = {
  repoSlug: vi.fn(),
  repoUpstream: vi.fn()
}

let container: HTMLDivElement
let root: Root

// @ts-expect-error test window mock
globalThis.window = { api: { gh: apiMocks } }

function makeRepo(overrides: Partial<Repo> = {}): Repo {
  return {
    id: 'repo-1',
    path: '/workspace/orca',
    displayName: 'orca',
    badgeColor: '#2563eb',
    addedAt: 1,
    kind: 'git',
    ...overrides
  }
}

async function flushEffects(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe('RepositoryIconPicker GitHub avatar refresh', () => {
  beforeEach(() => {
    apiMocks.repoSlug.mockReset()
    apiMocks.repoUpstream.mockReset()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    document.body.replaceChildren()
  })

  it('refreshes stale GitHub avatar metadata lazily when repo settings opens', async () => {
    const updateRepo = vi.fn()
    // Non-fork repo (upstream resolved to null) transferred stablyai -> parkerrex.
    const repo = makeRepo({
      upstream: null,
      repoIcon: {
        type: 'image',
        src: 'https://github.com/stablyai.png?size=64',
        source: 'github',
        label: 'stablyai/orca'
      }
    })
    apiMocks.repoUpstream.mockResolvedValueOnce(null)
    apiMocks.repoSlug.mockResolvedValueOnce({ owner: 'parkerrex', repo: 'orca' })

    act(() => {
      root.render(<RepositoryIconPicker repo={repo} updateRepo={updateRepo} />)
    })
    await flushEffects()

    expect(updateRepo).toHaveBeenCalledExactlyOnceWith('repo-1', {
      repoIcon: {
        type: 'image',
        src: 'https://github.com/parkerrex.png?size=64',
        source: 'github',
        label: 'parkerrex/orca'
      }
    })
  })

  it('does not clobber a fork identity when the live upstream lookup fails offline', async () => {
    const updateRepo = vi.fn()
    // A fork whose avatar tracks its parent org, resolved earlier while online.
    const repo = makeRepo({
      upstream: { owner: 'stablyai', repo: 'orca' },
      repoIcon: {
        type: 'image',
        src: 'https://github.com/stablyai.png?size=64',
        source: 'github',
        label: 'stablyai/orca'
      }
    })
    // Offline/unauthed: the parent lookup returns null. The fork's own origin
    // owner must NOT be persisted over the parent identity.
    apiMocks.repoUpstream.mockResolvedValueOnce(null)
    apiMocks.repoSlug.mockResolvedValueOnce({ owner: 'parkerrex', repo: 'orca' })

    act(() => {
      root.render(<RepositoryIconPicker repo={repo} updateRepo={updateRepo} />)
    })
    await flushEffects()

    expect(updateRepo).not.toHaveBeenCalled()
    expect(apiMocks.repoSlug).not.toHaveBeenCalled()
  })
})
