// @vitest-environment happy-dom

import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ORPHAN_WORKTREE_ID } from '../../../../shared/constants'
import type { UnifiedSessionRow, UnifiedWorktreeRow } from './resource-usage-merge-types'

vi.mock('@/store', () => {
  const storeState = {}
  const useAppStore = Object.assign(
    (selector: (state: typeof storeState) => unknown) => selector(storeState),
    { getState: () => storeState }
  )
  return { useAppStore }
})

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, values?: Record<string, string>) =>
    values
      ? Object.entries(values).reduce(
          (text, [token, value]) => text.replace(`{{${token}}}`, value),
          fallback
        )
      : fallback
}))

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn() }
}))

import { WorktreeRow } from './ResourceUsageStatusSegment'

function makeSession(overrides: Partial<UnifiedSessionRow>): UnifiedSessionRow {
  return {
    sessionId: 'sess-1',
    paneKey: null,
    pid: 100,
    label: 'zsh',
    bound: true,
    tabId: 'tab-1',
    cpu: 1,
    memory: 100,
    hasLocalSamples: true,
    ...overrides
  }
}

function makeWorktree(overrides: Partial<UnifiedWorktreeRow>): UnifiedWorktreeRow {
  return {
    worktreeId: 'wt-1',
    worktreeName: 'feature-branch',
    repoId: 'repo-1',
    repoName: 'repo',
    cpu: 1,
    memory: 100,
    history: [],
    hasLocalSamples: true,
    isRemote: false,
    sessions: [],
    ...overrides
  }
}

describe('resource manager row presentation', () => {
  let container: HTMLDivElement
  let root: Root

  afterEach(() => {
    act(() => {
      root.unmount()
    })
    container.remove()
  })

  function renderWorktreeRow(worktree: UnifiedWorktreeRow): void {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    act(() => {
      root.render(
        <WorktreeRow
          worktree={worktree}
          storeRecord={null}
          activeWorktreeId={null}
          isCollapsed={false}
          onToggle={() => {}}
          onNavigate={() => {}}
          onDelete={() => {}}
          onKillSession={() => {}}
          navigateToTab={() => {}}
        />
      )
    })
  }

  it('keeps the remote chip and kill affordances on SSH-backed rows', () => {
    renderWorktreeRow(
      makeWorktree({
        isRemote: true,
        cpu: null,
        memory: null,
        sessions: [
          makeSession({ sessionId: 'ssh-a', bound: true }),
          makeSession({ sessionId: 'ssh-b', bound: false, tabId: null, cpu: null, memory: null })
        ]
      })
    )

    expect(container.textContent).toContain('· remote')
    const killButtons = container.querySelectorAll('button[aria-label^="Kill session"]')
    expect(killButtons).toHaveLength(2)
    expect(container.querySelector('button[aria-label="Kill session ssh-a"]')).not.toBeNull()
    expect(container.querySelector('button[aria-label="Kill session ssh-b"]')).not.toBeNull()
  })

  it('keeps kill affordances on the orphan bucket rows', () => {
    renderWorktreeRow(
      makeWorktree({
        worktreeId: ORPHAN_WORKTREE_ID,
        worktreeName: 'Orphaned terminals',
        sessions: [makeSession({ sessionId: 'orphan-a', bound: false, tabId: null })]
      })
    )

    expect(container.querySelector('button[aria-label="Kill session orphan-a"]')).not.toBeNull()
  })
})
