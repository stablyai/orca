// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'
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

function makeRepo(): Repo {
  return {
    id: 'repo-1',
    path: '/workspace/orca',
    displayName: 'orca',
    badgeColor: '#2563eb',
    addedAt: 1,
    kind: 'git',
    upstream: null,
    repoIcon: {
      type: 'image',
      src: 'https://github.com/stablyai.png?size=64',
      source: 'github',
      label: 'stablyai/orca'
    }
  }
}

async function flushEffects(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

// A global default hides every avatar, so the picker must stop treating the stored avatar as
// something worth keeping fresh — on a private GitHub Enterprise host each refresh is a request to
// an internal server for an image nothing draws.
describe('RepositoryIconPicker with a global default project icon', () => {
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

  it('does not re-probe GitHub for an avatar the default replaces', async () => {
    act(() => {
      root.render(
        <RepositoryIconPicker
          repo={makeRepo()}
          updateRepo={vi.fn()}
          defaultProjectIcon={{ type: 'lucide', name: 'Folder' }}
        />
      )
    })
    await flushEffects()

    expect(apiMocks.repoSlug).not.toHaveBeenCalled()
    expect(apiMocks.repoUpstream).not.toHaveBeenCalled()
    expect(container.querySelector('img')).toBeNull()
  })

  it('previews the default in the color the sidebar draws it in', async () => {
    act(() => {
      root.render(
        <RepositoryIconPicker
          repo={makeRepo()}
          updateRepo={vi.fn()}
          defaultProjectIcon={{ type: 'lucide', name: 'Folder' }}
          defaultProjectIconColor="#e11d48"
        />
      )
    })
    await flushEffects()

    // Not the repo's own #2563eb badge color: the global default owns its tint.
    expect(container.querySelector('svg')?.getAttribute('style')).toContain('#e11d48')
  })

  it('still refreshes the avatar when no default is set', async () => {
    apiMocks.repoUpstream.mockResolvedValue(null)
    apiMocks.repoSlug.mockResolvedValue({ owner: 'stablyai', repo: 'orca' })

    act(() => {
      root.render(<RepositoryIconPicker repo={makeRepo()} updateRepo={vi.fn()} />)
    })
    await flushEffects()

    expect(apiMocks.repoSlug).toHaveBeenCalled()
  })

  it('resets to the global default instead of re-fetching the avatar', async () => {
    const updateRepo = vi.fn()

    act(() => {
      root.render(
        <RepositoryIconPicker
          repo={makeRepo()}
          updateRepo={updateRepo}
          defaultProjectIcon={{ type: 'lucide', name: 'Folder' }}
        />
      )
    })
    await flushEffects()

    const resetButton = [...container.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Reset')
    )
    act(() => {
      resetButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await flushEffects()

    expect(updateRepo).toHaveBeenCalledWith('repo-1', { repoIcon: null })
    expect(apiMocks.repoSlug).not.toHaveBeenCalled()
  })
})
