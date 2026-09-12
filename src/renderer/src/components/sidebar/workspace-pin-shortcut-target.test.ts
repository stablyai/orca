// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import type { AppState } from '@/store/types'
import type { Worktree } from '../../../../shared/worktree/types'
import {
  applyWorkspacePinIntent,
  resolveWorkspacePinShortcutTarget,
  type WorkspacePinShortcutState
} from './workspace-pin-shortcut-target'

function worktree(overrides: Partial<Worktree> = {}): Worktree {
  return {
    id: 'repo::/feature',
    repoId: 'repo',
    path: '/feature',
    branch: 'feature',
    isMainWorktree: false,
    isPinned: false,
    ...overrides
  } as Worktree
}

function hoveredDocument(...rows: { workspaceId: string; hostIdentity: string }[]) {
  return {
    activeElement: null,
    querySelectorAll: () => ({
      length: rows.length,
      item: (index: number) => {
        const row = rows[index]
        return row
          ? ({
              dataset: {
                worktreeId: row.workspaceId,
                worktreeHostIdentity: row.hostIdentity
              }
            } as unknown as HTMLElement)
          : null
      }
    })
  } as unknown as Pick<Document, 'activeElement' | 'querySelectorAll'>
}

function state(
  worktrees: Worktree[],
  overrides: Partial<WorkspacePinShortcutState> = {}
): WorkspacePinShortcutState {
  return {
    activeModal: 'none',
    activeWorkspaceExecutionHostId: null,
    activeWorkspaceKey: null,
    activeWorktreeId: worktrees[0]?.id ?? null,
    // Mirrors the store index: a row without an explicit hostId is owned by 'local'.
    getKnownWorktreeById: (worktreeId: string, executionHostId?: string) =>
      worktrees.find(
        (candidate) =>
          candidate.id === worktreeId &&
          (executionHostId === undefined || (candidate.hostId ?? 'local') === executionHostId)
      ),
    setWorktreesPinnedAndReveal: vi.fn(),
    ...overrides
  } as unknown as WorkspacePinShortcutState
}

describe('workspace pin shortcut target', () => {
  it('prefers the deepest hovered row over the active workspace', () => {
    const active = worktree({ id: 'repo::/active', path: '/active', hostId: 'local' })
    const hovered = worktree({ id: 'repo::/hovered', path: '/hovered', hostId: 'local' })

    expect(
      resolveWorkspacePinShortcutTarget(
        state([active, hovered]),
        hoveredDocument(
          { workspaceId: 'repo::/parent', hostIdentity: 'local|repo::/parent' },
          { workspaceId: 'repo::/hovered', hostIdentity: 'local|repo::/hovered' }
        )
      )
    ).toBe(hovered)
  })

  it('resolves the hovered row on its own execution host', () => {
    const local = worktree({ hostId: 'local' })
    const remote = worktree({ hostId: 'ssh:build' })

    expect(
      resolveWorkspacePinShortcutTarget(
        state([local, remote]),
        hoveredDocument({ workspaceId: 'repo::/feature', hostIdentity: 'ssh:build|repo::/feature' })
      )
    ).toBe(remote)
  })

  it('declines an unqualified hovered row that could be either host twin', () => {
    const local = worktree({ hostId: 'local' })
    const remote = worktree({ hostId: 'ssh:build' })

    expect(
      resolveWorkspacePinShortcutTarget(
        state([local, remote]),
        hoveredDocument({ workspaceId: 'repo::/feature', hostIdentity: '|repo::/feature' })
      )
    ).toBeNull()
  })

  it('falls back to the active workspace without a hovered row', () => {
    const active = worktree({ id: 'repo::/active', path: '/active' })

    expect(resolveWorkspacePinShortcutTarget(state([active]), hoveredDocument())).toBe(active)
  })

  it('resolves the active folder workspace through its workspace key', () => {
    const folder = worktree({ id: 'folder:abc', path: '/folder' })

    expect(
      resolveWorkspacePinShortcutTarget(
        state([folder], {
          activeWorkspaceKey: 'folder:abc' as AppState['activeWorkspaceKey'],
          activeWorktreeId: null
        }),
        hoveredDocument()
      )
    ).toBe(folder)
  })

  it('declines while a modal is open or a text field has focus', () => {
    const active = worktree()

    expect(
      resolveWorkspacePinShortcutTarget(
        state([active], { activeModal: 'quick-open' as AppState['activeModal'] }),
        hoveredDocument({ workspaceId: 'repo::/feature', hostIdentity: 'local|repo::/feature' })
      )
    ).toBeNull()
    expect(
      resolveWorkspacePinShortcutTarget(state([active]), {
        activeElement: document.createElement('input'),
        querySelectorAll: hoveredDocument().querySelectorAll
      } as unknown as Pick<Document, 'activeElement' | 'querySelectorAll'>)
    ).toBeNull()
  })

  it('declines an unknown workspace id', () => {
    expect(
      resolveWorkspacePinShortcutTarget(
        state([worktree()]),
        hoveredDocument({ workspaceId: 'repo::/gone', hostIdentity: 'local|repo::/gone' })
      )
    ).toBeNull()
  })

  it.each([
    { intent: 'pin' as const, wasPinned: false, expected: true },
    { intent: 'pin' as const, wasPinned: true, expected: true },
    { intent: 'unpin' as const, wasPinned: true, expected: false },
    { intent: 'unpin' as const, wasPinned: false, expected: false },
    { intent: 'toggle' as const, wasPinned: false, expected: true },
    { intent: 'toggle' as const, wasPinned: true, expected: false }
  ])(
    'writes $expected for $intent on a pinned=$wasPinned row',
    ({ intent, wasPinned, expected }) => {
      const target = worktree({ isPinned: wasPinned })
      const pinState = state([target])

      applyWorkspacePinIntent(pinState, target, intent)

      expect(pinState.setWorktreesPinnedAndReveal).toHaveBeenCalledWith([target.id], expected)
    }
  )

  it('carries the execution host into the pin write', () => {
    const target = worktree({ hostId: 'ssh:build' })
    const pinState = state([target])

    applyWorkspacePinIntent(pinState, target, 'pin')

    expect(pinState.setWorktreesPinnedAndReveal).toHaveBeenCalledWith(
      [{ worktreeId: 'repo::/feature', executionHostId: 'ssh:build' }],
      true
    )
  })
})
