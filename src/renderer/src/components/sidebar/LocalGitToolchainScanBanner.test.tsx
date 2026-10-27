// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useAppStore } from '@/store'
import type { Repo } from '../../../../shared/repo-types'
import { toast } from 'sonner'
import { makeDetectedResult } from '@/store/slices/worktrees-detected-listing-fixtures'
import { LocalGitToolchainScanBanner } from './LocalGitToolchainScanBanner'
import { RepoScanUnavailableIndicator } from './worktree-list/rows/RepoScanUnavailableIndicator'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

const XCODE_REASON =
  'You have not agreed to the Xcode license agreements. Agreeing to the Xcode/iOS license requires admin privileges, please run “sudo xcodebuild -license” and then retry this command.'

function makeRepo(id: string, host: Partial<Repo> = {}): Repo {
  return { id, path: `/repos/${id}`, displayName: id, badgeColor: '#000', addedAt: 0, ...host }
}

let repos = [makeRepo('web-app'), makeRepo('api-server')]
const initialState = useAppStore.getInitialState()
const roots: Root[] = []
const originalUserAgent = navigator.userAgent

function blockedListings(): Record<string, ReturnType<typeof makeDetectedResult>> {
  return Object.fromEntries(
    repos.map((repo) => [
      repo.id,
      makeDetectedResult(repo.id, [], {
        authoritative: false,
        source: 'metadata-fallback',
        unavailableReason: XCODE_REASON
      })
    ])
  )
}

async function render(): Promise<HTMLDivElement> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  await act(async () => {
    root.render(
      <TooltipProvider>
        <LocalGitToolchainScanBanner />
        {repos.map((repo) => (
          <RepoScanUnavailableIndicator key={repo.id} repo={repo} />
        ))}
      </TooltipProvider>
    )
  })
  return container
}

describe('LocalGitToolchainScanBanner', () => {
  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    Object.defineProperty(navigator, 'userAgent', {
      value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
      configurable: true
    })
    repos = [makeRepo('web-app'), makeRepo('api-server')]
    vi.mocked(toast.success).mockClear()
    useAppStore.setState(initialState, true)
  })

  afterEach(async () => {
    for (const root of roots.splice(0)) {
      await act(async () => root.unmount())
    }
    document.body.innerHTML = ''
    Object.defineProperty(navigator, 'userAgent', {
      value: originalUserAgent,
      configurable: true
    })
    useAppStore.setState(initialState, true)
  })

  it('shows one banner instead of a per-repo marker for an Xcode license failure', async () => {
    useAppStore.setState({ repos, detectedWorktreesByRepo: blockedListings() })

    const container = await render()

    expect(container.querySelectorAll('[role="alert"]')).toHaveLength(1)
    expect(container.textContent).toContain('sudo xcodebuild -license accept')
    expect(container.textContent).toContain('Worktree scan paused for 2 projects')
    expect(container.querySelector('button[aria-label^="Worktree scan failed"]')).toBeNull()
  })

  it('rescans every blocked repo when the window regains focus and confirms recovery', async () => {
    useAppStore.setState({ repos, detectedWorktreesByRepo: blockedListings() })
    const fetchWorktrees = vi
      .spyOn(useAppStore.getState(), 'fetchWorktrees')
      .mockImplementation(async () => true)
    await render()

    await act(async () => {
      window.dispatchEvent(new Event('focus'))
    })

    expect(fetchWorktrees).toHaveBeenCalledWith('web-app', { executionHostId: 'local' })
    expect(fetchWorktrees).toHaveBeenCalledWith('api-server', { executionHostId: 'local' })
    expect(toast.success).toHaveBeenCalledWith('Git is working again. Worktrees refreshed.', {
      id: 'local-git-toolchain-restored'
    })
  })

  it('keeps the success toast back while any repo is still blocked', async () => {
    useAppStore.setState({ repos, detectedWorktreesByRepo: blockedListings() })
    const fetchWorktrees = vi
      .spyOn(useAppStore.getState(), 'fetchWorktrees')
      .mockImplementation(async (repoId: string) => repoId === 'web-app')
    await render()

    await act(async () => {
      window.dispatchEvent(new Event('focus'))
    })

    expect(fetchWorktrees).toHaveBeenCalledTimes(2)
    expect(toast.success).not.toHaveBeenCalled()
  })

  it('leaves SSH and remote-runtime repos to the per-repo marker', async () => {
    repos = [
      makeRepo('ssh-repo', { connectionId: 'conn-1' }),
      makeRepo('runtime-repo', { executionHostId: 'runtime:env-1' })
    ]
    useAppStore.setState({ repos, detectedWorktreesByRepo: blockedListings() })

    const container = await render()

    expect(container.querySelector('[role="alert"]')).toBeNull()
    expect(container.querySelectorAll('button[aria-label^="Worktree scan failed"]')).toHaveLength(2)
  })

  it('renders nothing off macOS, leaving the per-repo marker', async () => {
    Object.defineProperty(navigator, 'userAgent', {
      value: 'Mozilla/5.0 (X11; Linux x86_64)',
      configurable: true
    })
    useAppStore.setState({ repos, detectedWorktreesByRepo: blockedListings() })

    const container = await render()

    expect(container.querySelector('[role="alert"]')).toBeNull()
    expect(container.querySelectorAll('button[aria-label^="Worktree scan failed"]')).toHaveLength(2)
  })
})
