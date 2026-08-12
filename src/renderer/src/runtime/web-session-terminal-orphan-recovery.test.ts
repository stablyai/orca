import { beforeEach, describe, expect, it, vi } from 'vitest'
import { toRemoteRuntimePtyId } from './runtime-terminal-stream'
import {
  clearWebSessionTerminalOrphanRecoveryForTests,
  recoverWebSessionTerminalOrphansBeforeApply
} from './web-session-terminal-orphan-recovery'

describe('web session terminal orphan recovery', () => {
  beforeEach(() => clearWebSessionTerminalOrphanRecoveryForTests())

  it('keeps a missing mirror pending until exact live orphan adoption returns', async () => {
    let resolveAdoption: ((value: never) => void) | null = null
    const adoptedSnapshot = {
      worktree: 'repo::C:\\worktree',
      publicationEpoch: 'adopted',
      snapshotVersion: 2,
      activeGroupId: 'group-1',
      activeTabId: 'host-tab::leaf-1',
      activeTabType: 'terminal' as const,
      tabs: [
        {
          type: 'terminal' as const,
          id: 'host-tab::leaf-1',
          parentTabId: 'host-tab',
          leafId: 'leaf-1',
          title: 'Claude',
          isActive: true,
          status: 'ready' as const,
          terminal: 'term_live'
        }
      ]
    }
    const call = vi.fn(async ({ method }) => {
      if (method === 'terminal.list') {
        return {
          ok: true as const,
          result: {
            terminals: [
              {
                handle: 'term_live',
                ptyId: 'native-pty',
                incarnationId: 'inc-1',
                orphaned: true,
                worktreeId: adoptedSnapshot.worktree
              }
            ],
            topologyRevisions: { [adoptedSnapshot.worktree]: 0 },
            totalCount: 1,
            truncated: false
          }
        }
      }
      return await new Promise((resolve) => {
        resolveAdoption = resolve as (value: never) => void
      })
    })
    const state = {
      tabsByWorktree: {
        [adoptedSnapshot.worktree]: [
          { id: 'web-terminal-host-tab', worktreeId: adoptedSnapshot.worktree } as never
        ]
      },
      terminalLayoutsByTabId: {
        'web-terminal-host-tab': {
          root: { type: 'leaf' as const, leafId: 'leaf-1' },
          activeLeafId: 'leaf-1',
          expandedLeafId: null,
          ptyIdsByLeafId: { 'leaf-1': toRemoteRuntimePtyId('term_live', 'windows-2') }
        }
      },
      activeTabIdByWorktree: { [adoptedSnapshot.worktree]: 'web-terminal-host-tab' },
      activeGroupIdByWorktree: { [adoptedSnapshot.worktree]: 'group-1' },
      groupsByWorktree: {
        [adoptedSnapshot.worktree]: [
          {
            id: 'group-1',
            worktreeId: adoptedSnapshot.worktree,
            activeTabId: 'web-terminal-host-tab',
            tabOrder: ['web-terminal-host-tab']
          }
        ]
      },
      layoutByWorktree: {
        [adoptedSnapshot.worktree]: { type: 'leaf' as const, groupId: 'group-1' }
      }
    }
    const missingSnapshot = { ...adoptedSnapshot, publicationEpoch: 'missing', tabs: [] }
    let settled = false
    const recovery = recoverWebSessionTerminalOrphansBeforeApply(
      state,
      missingSnapshot,
      'windows-2',
      call as never
    ).then((result) => {
      settled = true
      return result
    })
    await vi.waitFor(() => expect(resolveAdoption).not.toBeNull())
    expect(settled).toBe(false)
    expect(call).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        method: 'terminal.list',
        params: expect.objectContaining({ handles: ['term_live'] })
      })
    )
    resolveAdoption!({
      ok: true,
      result: { adopted: true, topologyRevision: 1, snapshot: adoptedSnapshot }
    } as never)

    await expect(recovery).resolves.toEqual(adoptedSnapshot)
    expect(call).toHaveBeenLastCalledWith(
      expect.objectContaining({
        method: 'terminal.adoptOrphans',
        params: expect.objectContaining({
          expectedTopologyRevision: 0,
          activeTabId: 'host-tab',
          claims: [
            expect.objectContaining({
              terminal: 'term_live',
              ptyId: 'native-pty',
              incarnationId: 'inc-1',
              tabId: 'host-tab',
              leafId: 'leaf-1'
            })
          ],
          topology: {
            tabs: [
              {
                tabId: 'host-tab',
                root: { type: 'leaf', leafId: 'leaf-1' },
                activeLeafId: 'leaf-1',
                expandedLeafId: null
              }
            ],
            groups: [{ id: 'group-1', activeTabId: 'host-tab', tabOrder: ['host-tab'] }],
            groupLayout: { type: 'leaf', groupId: 'group-1' }
          }
        })
      })
    )
  })

  it('does not apply absence when an exact recoverable orphan cannot be adopted yet', async () => {
    const worktree = 'repo::/worktree'
    const call = vi.fn(async ({ method }) =>
      method === 'terminal.list'
        ? {
            ok: true as const,
            result: {
              terminals: [
                {
                  handle: 'term_live',
                  ptyId: 'pty-live',
                  incarnationId: 'inc-live',
                  orphaned: true
                }
              ],
              topologyRevisions: { [worktree]: 4 },
              totalCount: 1,
              truncated: false
            }
          }
        : { ok: false as const, error: { code: 'conflict', message: 'retry' } }
    )
    const state = {
      tabsByWorktree: {
        [worktree]: [{ id: 'web-terminal-host-tab', worktreeId: worktree } as never]
      },
      terminalLayoutsByTabId: {
        'web-terminal-host-tab': {
          root: { type: 'leaf' as const, leafId: 'leaf-1' },
          activeLeafId: 'leaf-1',
          expandedLeafId: null,
          ptyIdsByLeafId: {
            'leaf-1': toRemoteRuntimePtyId('term_live', 'windows-2')
          }
        }
      },
      activeTabIdByWorktree: {},
      activeGroupIdByWorktree: {}
    }
    const missing = {
      worktree,
      publicationEpoch: 'missing',
      snapshotVersion: 1,
      activeGroupId: null,
      activeTabId: null,
      activeTabType: null,
      tabs: []
    }

    await expect(
      recoverWebSessionTerminalOrphansBeforeApply(state, missing, 'windows-2', call as never)
    ).resolves.toBeNull()
  })

  it('proposes pruned pane and group topology using host tab identities', async () => {
    const worktree = 'repo::/worktree'
    const adoptedSnapshot = {
      worktree,
      publicationEpoch: 'adopted',
      snapshotVersion: 2,
      activeGroupId: 'group-right',
      activeTabId: 'shell-tab',
      activeTabType: 'terminal' as const,
      tabs: []
    }
    const call = vi.fn(async ({ method }) =>
      method === 'terminal.list'
        ? {
            ok: true as const,
            result: {
              terminals: [
                {
                  handle: 'term_agent',
                  ptyId: 'pty-agent',
                  incarnationId: 'inc-agent',
                  orphaned: true
                },
                {
                  handle: 'term_setup',
                  ptyId: 'pty-setup',
                  incarnationId: 'inc-setup',
                  orphaned: true
                },
                {
                  handle: 'term_shell',
                  ptyId: 'pty-shell',
                  incarnationId: 'inc-shell',
                  orphaned: true
                }
              ],
              topologyRevisions: { [worktree]: 8 },
              totalCount: 3,
              truncated: false
            }
          }
        : {
            ok: true as const,
            result: { adopted: true, topologyRevision: 9, snapshot: adoptedSnapshot }
          }
    )
    const state = {
      tabsByWorktree: {
        [worktree]: [
          { id: 'web-terminal-agent-tab', worktreeId: worktree } as never,
          { id: 'web-terminal-shell-tab', worktreeId: worktree } as never
        ]
      },
      terminalLayoutsByTabId: {
        'web-terminal-agent-tab': {
          root: {
            type: 'split' as const,
            direction: 'horizontal' as const,
            ratio: 0.7,
            first: { type: 'leaf' as const, leafId: 'leaf-agent' },
            second: { type: 'leaf' as const, leafId: 'leaf-setup' }
          },
          activeLeafId: 'leaf-setup',
          expandedLeafId: null,
          ptyIdsByLeafId: {
            'leaf-agent': toRemoteRuntimePtyId('term_agent', 'windows-2'),
            'leaf-setup': toRemoteRuntimePtyId('term_setup', 'windows-2')
          }
        },
        'web-terminal-shell-tab': {
          root: { type: 'leaf' as const, leafId: 'leaf-shell' },
          activeLeafId: 'leaf-shell',
          expandedLeafId: 'leaf-shell',
          ptyIdsByLeafId: {
            'leaf-shell': toRemoteRuntimePtyId('term_shell', 'windows-2')
          }
        }
      },
      activeTabIdByWorktree: { [worktree]: 'web-terminal-shell-tab' },
      activeGroupIdByWorktree: { [worktree]: 'group-right' },
      groupsByWorktree: {
        [worktree]: [
          {
            id: 'group-left',
            worktreeId: worktree,
            activeTabId: 'web-terminal-agent-tab',
            tabOrder: ['web-terminal-agent-tab']
          },
          {
            id: 'group-right',
            worktreeId: worktree,
            activeTabId: 'web-terminal-shell-tab',
            tabOrder: ['web-terminal-shell-tab']
          }
        ]
      },
      layoutByWorktree: {
        [worktree]: {
          type: 'split' as const,
          direction: 'vertical' as const,
          ratio: 0.6,
          first: { type: 'leaf' as const, groupId: 'group-left' },
          second: { type: 'leaf' as const, groupId: 'group-right' }
        }
      }
    }

    await expect(
      recoverWebSessionTerminalOrphansBeforeApply(
        state,
        { ...adoptedSnapshot, publicationEpoch: 'missing' },
        'windows-2',
        call as never
      )
    ).resolves.toEqual(adoptedSnapshot)
    expect(call).toHaveBeenLastCalledWith(
      expect.objectContaining({
        method: 'terminal.adoptOrphans',
        params: expect.objectContaining({
          expectedTopologyRevision: 8,
          activeTabId: 'shell-tab',
          activeGroupId: 'group-right',
          topology: {
            tabs: [
              expect.objectContaining({
                tabId: 'agent-tab',
                root: expect.objectContaining({
                  type: 'split',
                  direction: 'horizontal',
                  ratio: 0.7
                }),
                activeLeafId: 'leaf-setup'
              }),
              expect.objectContaining({
                tabId: 'shell-tab',
                expandedLeafId: 'leaf-shell'
              })
            ],
            groups: [
              expect.objectContaining({
                id: 'group-left',
                activeTabId: 'agent-tab',
                tabOrder: ['agent-tab']
              }),
              expect.objectContaining({
                id: 'group-right',
                activeTabId: 'shell-tab',
                tabOrder: ['shell-tab']
              })
            ],
            groupLayout: expect.objectContaining({
              type: 'split',
              direction: 'vertical',
              ratio: 0.6
            })
          }
        })
      })
    )
  })

  it('recovers a missing split leaf when another leaf in the same tab is already host-owned', async () => {
    const worktree = 'repo::/worktree'
    const hostSnapshot = {
      worktree,
      publicationEpoch: 'partial',
      snapshotVersion: 2,
      activeGroupId: 'group-1',
      activeTabId: 'host-tab::leaf-owned',
      activeTabType: 'terminal' as const,
      tabs: [
        {
          type: 'terminal' as const,
          id: 'host-tab::leaf-owned',
          parentTabId: 'host-tab',
          leafId: 'leaf-owned',
          title: 'Shell',
          isActive: true,
          status: 'ready' as const,
          terminal: 'term_owned'
        }
      ]
    }
    const adoptedSnapshot = {
      ...hostSnapshot,
      publicationEpoch: 'adopted',
      snapshotVersion: 3
    }
    const call = vi.fn(async ({ method }) =>
      method === 'terminal.list'
        ? {
            ok: true as const,
            result: {
              terminals: [
                {
                  handle: 'term_orphan',
                  ptyId: 'pty-orphan',
                  incarnationId: 'inc-orphan',
                  orphaned: true
                }
              ],
              topologyRevisions: { [worktree]: 2 },
              totalCount: 1,
              truncated: false
            }
          }
        : {
            ok: true as const,
            result: { adopted: true, topologyRevision: 3, snapshot: adoptedSnapshot }
          }
    )
    const state = {
      tabsByWorktree: {
        [worktree]: [{ id: 'web-terminal-host-tab', worktreeId: worktree } as never]
      },
      terminalLayoutsByTabId: {
        'web-terminal-host-tab': {
          root: {
            type: 'split' as const,
            direction: 'vertical' as const,
            ratio: 0.5,
            first: { type: 'leaf' as const, leafId: 'leaf-owned' },
            second: { type: 'leaf' as const, leafId: 'leaf-orphan' }
          },
          activeLeafId: 'leaf-owned',
          expandedLeafId: null,
          ptyIdsByLeafId: {
            'leaf-owned': toRemoteRuntimePtyId('term_owned', 'windows-2'),
            'leaf-orphan': toRemoteRuntimePtyId('term_orphan', 'windows-2')
          }
        }
      },
      activeTabIdByWorktree: { [worktree]: 'web-terminal-host-tab' },
      activeGroupIdByWorktree: { [worktree]: 'group-1' }
    }

    await expect(
      recoverWebSessionTerminalOrphansBeforeApply(state, hostSnapshot, 'windows-2', call as never)
    ).resolves.toEqual(adoptedSnapshot)
    expect(call).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        method: 'terminal.list',
        params: expect.objectContaining({ handles: ['term_orphan'] })
      })
    )
    expect(call).toHaveBeenLastCalledWith(
      expect.objectContaining({
        method: 'terminal.adoptOrphans',
        params: expect.objectContaining({
          claims: [
            expect.objectContaining({
              terminal: 'term_orphan',
              tabId: 'host-tab',
              leafId: 'leaf-orphan'
            })
          ],
          topology: expect.objectContaining({
            tabs: [
              expect.objectContaining({
                tabId: 'host-tab',
                root: { type: 'leaf', leafId: 'leaf-orphan' }
              })
            ]
          })
        })
      })
    )
  })

  it('serializes a newer convergence snapshot after an in-flight adoption conflict', async () => {
    const worktree = 'repo::/worktree'
    let rejectFirstAdoption: (() => void) | null = null
    const call = vi.fn(async ({ method }) => {
      if (method === 'terminal.list') {
        return {
          ok: true as const,
          result: {
            terminals: [
              {
                handle: 'term_live',
                ptyId: 'pty-live',
                incarnationId: 'inc-live',
                orphaned: true
              }
            ],
            topologyRevisions: { [worktree]: 1 },
            totalCount: 1,
            truncated: false
          }
        }
      }
      return await new Promise((resolve) => {
        rejectFirstAdoption = () =>
          resolve({ ok: false as const, error: { code: 'conflict', message: 'closed' } })
      })
    })
    const state = {
      tabsByWorktree: {
        [worktree]: [{ id: 'web-terminal-host-tab', worktreeId: worktree } as never]
      },
      terminalLayoutsByTabId: {
        'web-terminal-host-tab': {
          root: { type: 'leaf' as const, leafId: 'leaf-1' },
          activeLeafId: 'leaf-1',
          expandedLeafId: null,
          ptyIdsByLeafId: {
            'leaf-1': toRemoteRuntimePtyId('term_live', 'windows-2')
          }
        }
      },
      activeTabIdByWorktree: {},
      activeGroupIdByWorktree: {}
    }
    const missing = {
      worktree,
      publicationEpoch: 'missing',
      snapshotVersion: 1,
      activeGroupId: null,
      activeTabId: null,
      activeTabType: null,
      tabs: []
    }
    const converged = {
      ...missing,
      publicationEpoch: 'closed',
      snapshotVersion: 2,
      tabs: [
        {
          type: 'terminal' as const,
          id: 'host-tab::leaf-1',
          parentTabId: 'host-tab',
          leafId: 'leaf-1',
          title: 'closed',
          isActive: false,
          status: 'pending-handle' as const,
          terminal: null
        }
      ]
    }

    const first = recoverWebSessionTerminalOrphansBeforeApply(
      state,
      missing,
      'windows-2',
      call as never
    )
    await vi.waitFor(() => expect(rejectFirstAdoption).not.toBeNull())
    const second = recoverWebSessionTerminalOrphansBeforeApply(
      state,
      converged,
      'windows-2',
      call as never
    )
    rejectFirstAdoption!()

    await expect(first).resolves.toBeNull()
    await expect(second).resolves.toEqual(converged)
  })
})
