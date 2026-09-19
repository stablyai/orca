// @vitest-environment happy-dom

import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'
import { CreateFromPicker } from './CreateFromPicker'
import {
  getRuntimeRepoBaseRefDefault,
  searchRuntimeRepoBaseRefs
} from '@/runtime/runtime-repo-client'

vi.mock('@/components/ui/popover', () => ({
  // Why: the real popover owns open state; expose onOpenChange so a test can open the list.
  Popover: ({
    children,
    onOpenChange
  }: {
    children: React.ReactNode
    onOpenChange?: (open: boolean) => void
  }) => (
    <div>
      <button type="button" data-testid="open-popover" onClick={() => onOpenChange?.(true)} />
      {children}
    </div>
  ),
  PopoverContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PopoverTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>
}))

vi.mock('@/components/ui/command', () => ({
  Command: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  CommandEmpty: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  CommandInput: () => <input />,
  CommandItem: ({ children }: { children: React.ReactNode }) => <button>{children}</button>,
  CommandList: ({ children }: { children: React.ReactNode }) => <div>{children}</div>
}))

const storeState = {
  settings: { activeRuntimeEnvironmentId: 'focused-runtime' },
  repos: [] as Pick<Repo, 'id' | 'connectionId' | 'executionHostId'>[]
}

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: typeof storeState) => unknown) => selector(storeState)
}))

vi.mock('@/runtime/runtime-repo-client', () => ({
  getRuntimeRepoBaseRefDefault: vi.fn().mockResolvedValue({
    defaultBaseRef: 'main',
    remoteCount: 1
  }),
  searchRuntimeRepoBaseRefs: vi.fn().mockResolvedValue([])
}))

let container: HTMLDivElement
let root: Root

function repoMapFor(repo: Repo): Map<string, Repo> {
  return new Map([[repo.id, repo]])
}

function makeRepo(overrides: Partial<Repo>): Repo {
  return {
    id: 'repo-1',
    path: '/repo',
    displayName: 'Repo',
    badgeColor: '#000000',
    addedAt: 1,
    ...overrides
  }
}

async function renderPicker(repo: Repo): Promise<void> {
  await act(async () => {
    root.render(
      <CreateFromPicker
        repoId={repo.id}
        repoMap={repoMapFor(repo)}
        worktrees={[]}
        value=""
        onValueChange={vi.fn()}
      />
    )
  })
}

describe('CreateFromPicker host routing', () => {
  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    vi.clearAllMocks()
  })

  afterEach(() => {
    act(() => {
      root.unmount()
    })
    container.remove()
    storeState.repos = []
  })

  it('uses the selected runtime-owned repo host instead of the focused runtime', async () => {
    const repo = makeRepo({ executionHostId: 'runtime:owner-runtime' })
    storeState.repos = [repo]

    await renderPicker(repo)

    expect(getRuntimeRepoBaseRefDefault).toHaveBeenCalledWith(
      { activeRuntimeEnvironmentId: 'owner-runtime' },
      repo.id
    )
  })

  // Why: the composer's Branch tab already lists on an empty query; a minimum-length gate left
  // this picker showing only the default ref and branches that happen to have a worktree.
  it('lists the repo branches as soon as it opens, with no query typed', async () => {
    const repo = makeRepo({ executionHostId: 'local' })
    storeState.repos = [repo]

    await renderPicker(repo)
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="open-popover"]')?.click()
    })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 250))
    })

    expect(searchRuntimeRepoBaseRefs).toHaveBeenCalledWith(
      { activeRuntimeEnvironmentId: null },
      repo.id,
      '',
      30
    )
  })

  it('keeps an explicit local repo on the local client even when a runtime is focused', async () => {
    const repo = makeRepo({ executionHostId: 'local' })
    storeState.repos = [repo]

    await renderPicker(repo)

    expect(getRuntimeRepoBaseRefDefault).toHaveBeenCalledWith(
      { activeRuntimeEnvironmentId: null },
      repo.id
    )
    expect(searchRuntimeRepoBaseRefs).not.toHaveBeenCalled()
  })
})
