// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import type { Repo } from '../../../../../../shared/repo-types'
import { makeDetectedResult } from '@/store/slices/worktrees-detected-listing-fixtures'
import { RepoScanUnavailableIndicator } from './RepoScanUnavailableIndicator'

vi.mock('@/components/ui/popover', () => ({
  Popover: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  PopoverContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  PopoverTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>
}))

const repo: Repo = {
  id: 'repo-1',
  path: 'C:\\repo',
  displayName: 'repo',
  badgeColor: '#000',
  addedAt: 0
}

const asStoreFetch = (mock: unknown): AppState['fetchWorktrees'] =>
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the store's fetchWorktrees is overloaded (direct-SSH result and boolean forms); this test only drives the boolean form.
  mock as AppState['fetchWorktrees']

const initialState = useAppStore.getInitialState()
const roots: Root[] = []

async function render(): Promise<HTMLDivElement> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  await act(async () => {
    root.render(<RepoScanUnavailableIndicator repo={repo} />)
  })
  return container
}

describe('RepoScanUnavailableIndicator', () => {
  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    useAppStore.setState(initialState, true)
  })

  afterEach(async () => {
    for (const root of roots.splice(0)) {
      await act(async () => root.unmount())
    }
    document.body.innerHTML = ''
    useAppStore.setState(initialState, true)
  })

  it('renders nothing for an authoritative listing', async () => {
    useAppStore.setState({
      detectedWorktreesByRepo: { [repo.id]: makeDetectedResult(repo.id, []) }
    })

    const container = await render()

    expect(container.querySelector('button')).toBeNull()
  })

  // Why: a non-authoritative listing without a reason is the disconnected-SSH shape, which the
  // host header already explains; this marker is only for a scan that failed with a cause.
  it('renders nothing for a non-authoritative listing that carries no reason', async () => {
    useAppStore.setState({
      detectedWorktreesByRepo: {
        [repo.id]: makeDetectedResult(repo.id, [], {
          authoritative: false,
          source: 'metadata-fallback'
        })
      }
    })

    const container = await render()

    expect(container.querySelector('button')).toBeNull()
  })

  it('marks a failed scan and re-runs it from the panel', async () => {
    const fetchWorktrees = vi.fn(async () => true)
    useAppStore.setState({
      repos: [repo],
      fetchWorktrees: asStoreFetch(fetchWorktrees),
      detectedWorktreesByRepo: {
        [repo.id]: makeDetectedResult(repo.id, [], {
          authoritative: false,
          source: 'metadata-fallback',
          unavailableReason: 'wsl.exe host failure (distro "kali-linux"): WSL_E_DISTRO_NOT_FOUND'
        })
      }
    })

    const container = await render()
    const marker = container.querySelector('button[data-repo-header-action]')

    expect(marker?.getAttribute('aria-label')).toContain('Worktree scan failed for repo')
    expect(marker?.className).toContain('text-destructive')

    let retry: HTMLButtonElement | null = null
    for (const node of container.querySelectorAll('button')) {
      if (node instanceof HTMLButtonElement && node.textContent?.includes('Retry scan')) {
        retry = node
      }
    }
    await act(async () => {
      retry?.click()
    })

    expect(fetchWorktrees).toHaveBeenCalledWith(repo.id, {
      executionHostId: 'local',
      requireAuthoritative: true
    })
  })
})
