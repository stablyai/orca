// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../../../shared/repo-types'
import { getProjectIdentityKey } from '../../../../../../shared/project-host-setup-projection'
import { RepositoryIconPicker } from './RepositoryIconPicker'

vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({
  callRuntimeRpc: vi.fn()
}))

vi.mock('./RepositoryIconColorSection', () => ({
  RepositoryIconColorSection: () => null
}))

vi.mock('./RepositoryIconTabs', () => ({
  RepositoryIconTabs: ({ onUseGitHubAvatar }: { onUseGitHubAvatar: () => void }) => (
    <button data-avatar-action onClick={onUseGitHubAvatar} />
  )
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

describe('RepositoryIconPicker GitHub identity', () => {
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

  it.each([
    { state: 'selected origin', upstream: { owner: 'brennanb2025', repo: 'learnsomething' } },
    { state: 'defined nonfork', upstream: null },
    { state: 'unavailable metadata', upstream: undefined }
  ])('preserves saved $state when settings opens and reopens', async ({ upstream }) => {
    const original = makeRepo({
      upstream,
      gitRemoteIdentity: {
        canonicalKey: 'github.com/brennanb2025/learnsomething',
        remoteName: 'origin',
        remoteUrl: 'https://github.com/brennanb2025/learnsomething.git'
      },
      ...(upstream !== undefined
        ? {
            repoIcon: {
              type: 'image',
              src: 'https://github.com/echavemann.png?size=64',
              source: 'github',
              label: upstream === null ? 'brennanb2025/learnsomething' : 'echavemann/learnsomething'
            } as const
          }
        : {})
    })
    let saved: Repo = JSON.parse(JSON.stringify(original))
    apiMocks.repoUpstream.mockResolvedValue(
      upstream === undefined ? null : { owner: 'echavemann', repo: 'learnsomething' }
    )
    apiMocks.repoSlug.mockResolvedValue({ owner: 'brennanb2025', repo: 'learnsomething' })
    const updateRepo = (_id: string, updates: Partial<Repo>) => {
      saved = { ...saved, ...updates }
    }

    act(() => root.render(<RepositoryIconPicker repo={saved} updateRepo={updateRepo} />))
    await flushEffects()
    act(() => root.unmount())
    saved = JSON.parse(JSON.stringify(saved))
    root = createRoot(container)
    act(() => root.render(<RepositoryIconPicker repo={saved} updateRepo={updateRepo} />))
    await flushEffects()

    expect(saved.upstream).toEqual(upstream)
    expect(saved.repoIcon).toEqual(original.repoIcon)
    expect(getProjectIdentityKey(saved)).toBe('github:brennanb2025/learnsomething')
  })

  it('still applies a live GitHub avatar when the user requests it', async () => {
    let saved = makeRepo({ upstream: null })
    apiMocks.repoUpstream.mockResolvedValue({ owner: 'echavemann', repo: 'learnsomething' })
    apiMocks.repoSlug.mockResolvedValue({ owner: 'brennanb2025', repo: 'learnsomething' })
    const updateRepo = (_id: string, updates: Partial<Repo>) => {
      saved = { ...saved, ...updates }
    }
    act(() => root.render(<RepositoryIconPicker repo={saved} updateRepo={updateRepo} />))
    await flushEffects()
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-avatar-action]')?.click()
    })
    await flushEffects()

    expect(saved.upstream).toEqual({ owner: 'echavemann', repo: 'learnsomething' })
    expect(saved.repoIcon).toEqual({
      type: 'image',
      src: 'https://github.com/echavemann.png?size=64',
      source: 'github',
      label: 'echavemann/learnsomething'
    })
    expect(getProjectIdentityKey(saved)).toBe('github:echavemann/learnsomething')
  })
})
