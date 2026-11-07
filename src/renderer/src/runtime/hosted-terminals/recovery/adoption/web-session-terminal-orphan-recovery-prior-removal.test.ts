import { describe, expect, it } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../../../../../shared/runtime-session-contracts'
import { mergeAdoptionResponse } from './web-session-terminal-orphan-recovery-adoption'

describe('post-adoption reconciliation of previously removed surfaces', () => {
  it('preserves a newer host-published pending row after the old surface was removed', () => {
    const projected: RuntimeMobileSessionTabsResult = {
      worktree: 'folder:post-adoption-prior-removal',
      publicationEpoch: 'renderer:host:client-navigation',
      snapshotVersion: 2,
      activeGroupId: null,
      activeTabId: null,
      activeTabType: null,
      retiredTerminalSurfaces: [],
      tabs: [
        {
          type: 'terminal',
          id: 'host-tab::leaf-claim',
          parentTabId: 'host-tab',
          leafId: 'leaf-claim',
          title: 'leaf-claim',
          ptyId: 'pty-claim',
          isActive: false,
          status: 'ready',
          terminal: 'term-claim'
        },
        {
          type: 'terminal',
          id: 'host-tab::leaf-old',
          parentTabId: 'host-tab',
          leafId: 'leaf-old',
          title: 'leaf-old',
          ptyId: 'pty-new',
          isActive: false,
          status: 'pending-handle',
          terminal: null
        }
      ]
    }

    const merged = mergeAdoptionResponse(projected, [], [], new Set(['host-tab\0leaf-old']))

    expect(merged.tabs).toEqual([
      {
        type: 'terminal',
        id: 'host-tab::leaf-claim',
        parentTabId: 'host-tab',
        leafId: 'leaf-claim',
        title: 'leaf-claim',
        ptyId: 'pty-claim',
        isActive: false,
        status: 'ready',
        terminal: 'term-claim'
      },
      {
        type: 'terminal',
        id: 'host-tab::leaf-old',
        parentTabId: 'host-tab',
        leafId: 'leaf-old',
        title: 'leaf-old',
        ptyId: 'pty-new',
        isActive: false,
        status: 'pending-handle',
        terminal: null
      }
    ])
  })
})
