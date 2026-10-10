import { expect, it } from 'vitest'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import {
  getTerminalPtyOwnershipIdentity,
  hasTerminalPtyOwnerOutsidePane,
  type TerminalTabRetirementState
} from './terminal-tab-retirement'

function tab(id: string, ptyId: string | null = null): TerminalTab {
  return {
    id,
    worktreeId: 'wt',
    ptyId,
    title: id,
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
}
function state(): TerminalTabRetirementState {
  return {
    worktreesByRepo: { repo: [{ id: 'wt', repoId: 'repo', runtimeOwnerEnvironmentId: 'env-1' }] },
    tabsByWorktree: { wt: [tab('closing', 'remote:env-1@@session')] },
    unifiedTabsByWorktree: {},
    ptyIdsByTabId: { closing: ['remote:env-1@@session'] },
    terminalLayoutsByTabId: {
      closing: {
        root: null,
        activeLeafId: null,
        expandedLeafId: null,
        ptyIdsByLeafId: { original: 'remote:env-1@@session' }
      }
    },
    lastKnownRelayPtyIdByTabId: {},
    deferredSshSessionIdsByTabId: {},
    pendingReconnectPtyIdByTabId: {}
  }
}

it('ignores the closing leaf and its aggregate row, but protects a sibling legacy alias', () => {
  const current = state()
  const identity = getTerminalPtyOwnershipIdentity(current, 'remote:env-1@@session', 'wt')
  expect(hasTerminalPtyOwnerOutsidePane(current, identity, 'closing', 'original')).toBe(false)
  current.terminalLayoutsByTabId.closing.ptyIdsByLeafId = {
    original: 'remote:env-1@@session',
    sibling: 'remote:session'
  }
  expect(hasTerminalPtyOwnerOutsidePane(current, identity, 'closing', 'original')).toBe(true)
})

it('the late check protects replacement ownership at the same durable leaf', () => {
  const current = state()
  const identity = getTerminalPtyOwnershipIdentity(current, 'remote:session', 'wt')
  expect(hasTerminalPtyOwnerOutsidePane(current, identity, 'closing')).toBe(true)
})

it.each(['row', 'layout', 'aggregate', 'relay', 'deferred', 'reconnect'] as const)(
  'protects another live tab with only %s ownership',
  (source) => {
    const current = state()
    const id = 'remote:session'
    current.tabsByWorktree.wt.push(tab('survivor', source === 'row' ? id : null))
    if (source === 'layout') {
      current.terminalLayoutsByTabId.survivor = {
        root: null,
        activeLeafId: null,
        expandedLeafId: null,
        ptyIdsByLeafId: { leaf: id }
      }
    } else if (source === 'aggregate') {
      current.ptyIdsByTabId.survivor = [id]
    } else if (source === 'relay') {
      current.lastKnownRelayPtyIdByTabId.survivor = id
    } else if (source === 'deferred') {
      current.deferredSshSessionIdsByTabId.survivor = id
    } else if (source === 'reconnect') {
      current.pendingReconnectPtyIdByTabId.survivor = id
    }
    const identity = getTerminalPtyOwnershipIdentity(current, 'remote:env-1@@session', 'wt')
    expect(hasTerminalPtyOwnerOutsidePane(current, identity, 'closing', 'original')).toBe(true)
    current.tabsByWorktree.wt.pop()
    expect(hasTerminalPtyOwnerOutsidePane(current, identity, 'closing', 'original')).toBe(false)
  }
)
