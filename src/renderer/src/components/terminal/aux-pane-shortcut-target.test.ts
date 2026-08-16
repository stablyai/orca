// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'
import {
  registerAuxPaneContainer,
  unregisterAuxPaneContainer
} from '@/lib/aux-pane-window-registry'
import {
  auxiliaryTerminalShortcutTarget,
  getTerminalShortcutPaneHandle,
  getTerminalShortcutPaneRefCallback,
  resolveTerminalCreationShortcutWorktreeId,
  resolveTerminalShortcutTabId,
  resolveTerminalShortcutTarget
} from './aux-pane-shortcut-target'

const GROUP_ID = 'detached-group'

afterEach(() => {
  unregisterAuxPaneContainer(GROUP_ID)
})

describe('resolveTerminalShortcutTarget', () => {
  it('keeps only auxiliary targets for main-window guard overrides', () => {
    const main = { worktreeId: 'main', groupId: 'main-group', auxiliary: false }
    const auxiliary = { worktreeId: 'aux', groupId: GROUP_ID, auxiliary: true }

    expect(auxiliaryTerminalShortcutTarget(main)).toBeNull()
    expect(auxiliaryTerminalShortcutTarget(auxiliary)).toBe(auxiliary)
  })

  it('scopes floating creation policy to the floating workspace', () => {
    const main = { worktreeId: 'main', groupId: 'main-group', auxiliary: false }

    expect(resolveTerminalCreationShortcutWorktreeId(main, false)).toBe('main')
    expect(resolveTerminalCreationShortcutWorktreeId(main, true)).toBe(
      FLOATING_TERMINAL_WORKTREE_ID
    )
  })

  it('uses the focused aux group owner instead of the main active worktree', () => {
    const auxDocument = document.implementation.createHTMLDocument('Aux')
    const container = auxDocument.createElement('div')
    const target = auxDocument.createElement('textarea')
    container.append(target)
    registerAuxPaneContainer(GROUP_ID, container)

    expect(
      resolveTerminalShortcutTarget(target, {
        activeWorktreeId: 'main-worktree',
        activeGroupIdByWorktree: { 'main-worktree': 'main-group' },
        groupsByWorktree: {
          'main-worktree': [
            {
              id: 'main-group',
              worktreeId: 'main-worktree',
              activeTabId: null,
              tabOrder: []
            }
          ],
          'detached-worktree': [
            {
              id: GROUP_ID,
              worktreeId: 'detached-worktree',
              activeTabId: null,
              tabOrder: []
            }
          ]
        }
      })
    ).toEqual({ worktreeId: 'detached-worktree', groupId: GROUP_ID, auxiliary: true })
  })

  it('resolves the active terminal entity in the aux group', () => {
    expect(
      resolveTerminalShortcutTabId(
        { worktreeId: 'detached-worktree', groupId: GROUP_ID },
        {
          groupsByWorktree: {
            'detached-worktree': [
              {
                id: GROUP_ID,
                worktreeId: 'detached-worktree',
                activeTabId: 'unified-terminal',
                tabOrder: ['unified-terminal']
              }
            ]
          },
          unifiedTabsByWorktree: {
            'detached-worktree': [
              {
                id: 'unified-terminal',
                entityId: 'terminal-entity',
                groupId: GROUP_ID,
                worktreeId: 'detached-worktree',
                contentType: 'terminal',
                label: 'Terminal',
                customLabel: null,
                color: null,
                sortOrder: 0,
                createdAt: 1
              }
            ]
          }
        }
      )
    ).toBe('terminal-entity')
  })

  it('routes the resolved terminal to its mounted pane command handle', () => {
    const closeActivePane = vi.fn()
    const ref = getTerminalShortcutPaneRefCallback('terminal-entity')
    ref({ closeActivePane })

    getTerminalShortcutPaneHandle('terminal-entity')?.closeActivePane()

    expect(closeActivePane).toHaveBeenCalledOnce()
    ref(null)
    expect(getTerminalShortcutPaneHandle('terminal-entity')).toBeNull()
  })
})
