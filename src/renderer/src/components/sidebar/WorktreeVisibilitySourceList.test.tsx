// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import type { Repo } from '../../../../shared/repo-types'
import type { DetectedWorktree } from '../../../../shared/worktree/types'
import WorktreeVisibilitySourceList from './WorktreeVisibilitySourceList'

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <>{children}</>
}))

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('WorktreeVisibilitySourceList', () => {
  it('counts a configured built-in base as another external location', () => {
    const repo: Repo = {
      id: 'repo-1',
      path: '/repo',
      displayName: 'orca',
      badgeColor: '#000000',
      addedAt: 0,
      worktreeBasePath: '.claude/worktrees'
    }
    const worktrees = [
      {
        path: '/repo/.claude/worktrees/review',
        selectedCheckout: false,
        ownership: 'external'
      },
      { path: '/outside/review', selectedCheckout: false, ownership: 'external' }
    ] as DetectedWorktree[]

    act(() => {
      root.render(
        <WorktreeVisibilitySourceList
          repo={repo}
          worktrees={worktrees}
          disabled={false}
          onAdd={async () => 'added'}
          onRemove={async () => {}}
          onToggle={async () => {}}
        />
      )
    })

    expect(container.querySelector('[data-source-row="built-in:claude"]')?.textContent).toContain(
      '0 found'
    )
    expect(container.querySelector('[data-source-row="other"]')?.textContent).toContain('2 found')
  })

  it('offers a reset when a project override already matches the global value', async () => {
    const onUseDefault = vi.fn()
    const repo: Repo = {
      id: 'repo-1',
      path: '/repo',
      displayName: 'orca',
      badgeColor: '#000000',
      addedAt: 0,
      worktreeVisibilitySourcePreferences: { builtIn: { claude: 'show' } }
    }
    act(() => {
      root.render(
        <WorktreeVisibilitySourceList
          repo={repo}
          visibilityDefaults={{
            external: 'hide',
            sourcePreferences: { builtIn: { claude: 'show' } }
          }}
          disabled={false}
          onAdd={async () => 'added'}
          onRemove={async () => {}}
          onToggle={async () => {}}
          onUseDefault={onUseDefault}
        />
      )
    })

    const reset = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Use global for Claude Code"]'
    )
    expect(reset).not.toBeNull()
    expect(container.querySelectorAll('button[aria-label^="Use global for "]')).toHaveLength(1)
    expect(reset?.closest('[data-source-row]')?.textContent).not.toContain(
      'Overriding global setting'
    )
    await act(async () => reset?.click())

    expect(onUseDefault).toHaveBeenCalledWith({ kind: 'built-in', id: 'claude' })
  })
})
