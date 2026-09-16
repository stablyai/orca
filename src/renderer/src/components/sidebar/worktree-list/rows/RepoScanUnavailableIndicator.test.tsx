// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useAppStore } from '@/store'
import type { Repo } from '../../../../../../shared/repo-types'
import { makeDetectedResult } from '@/store/slices/worktrees-detected-listing-fixtures'
import { RepoScanUnavailableIndicator } from './RepoScanUnavailableIndicator'

const repo = {
  id: 'repo-1',
  path: 'C:\\repo',
  displayName: 'repo',
  badgeColor: '#000',
  addedAt: 0
} as Repo

const initialState = useAppStore.getInitialState()
const roots: Root[] = []

async function render(): Promise<HTMLDivElement> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  await act(async () => {
    root.render(
      <TooltipProvider>
        <RepoScanUnavailableIndicator repo={repo} />
      </TooltipProvider>
    )
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

  it('marks a failed scan and re-runs it on click', async () => {
    const fetchWorktrees = vi.fn(async () => true)
    useAppStore.setState({
      fetchWorktrees: fetchWorktrees as never,
      detectedWorktreesByRepo: {
        [repo.id]: makeDetectedResult(repo.id, [], {
          authoritative: false,
          source: 'metadata-fallback',
          unavailableReason: 'wsl.exe host failure (distro "kali-linux"): WSL_E_DISTRO_NOT_FOUND'
        })
      }
    })

    const container = await render()
    const button = container.querySelector('button')

    expect(button?.getAttribute('aria-label')).toContain('Worktree scan failed for repo')
    expect(button?.className).toContain('text-destructive')
    await act(async () => {
      button?.click()
    })
    expect(fetchWorktrees).toHaveBeenCalledWith(repo.id, { executionHostId: 'local' })
  })
})
