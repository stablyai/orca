import { beforeEach, describe, expect, it } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../../../shared/runtime-types'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import { buildMirroredTerminalTabs } from './terminal-build'
import { toWebTerminalSurfaceTabId } from '../web-terminal-surface-id'
import {
  recordLocalViewModeWrite,
  resetLocalViewModeWritesForTests,
  settleLocalViewModeWrite
} from './last-local-view-mode-write'

/**
 * viewMode is host-tracked and shared across paired clients, so a rebuild has to tell another
 * client's change apart from this client's own write. The record of that write separates them for
 * as long as its RPC is in flight: inside that window the host still reports the value it held
 * before the write, which is why a differing value is not yet a peer's. Settling drops the record,
 * so afterwards the host wins again and a tab never stays on a value the host has left behind.
 */
const WORKTREE = 'repo-1::worktree-1'
const ENVIRONMENT = 'env-1'
const HOST_TAB = 'host-tab-1'

function snapshot(viewMode?: 'terminal' | 'chat'): RuntimeMobileSessionTabsResult {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fields the mirroring path reads are the ones stated here; the cast fills the rest of the host result shape.
  return {
    worktree: WORKTREE,
    publicationEpoch: 'epoch-1',
    snapshotVersion: 1,
    activeGroupId: 'group-1',
    activeTabId: null,
    activeTabType: null,
    tabs: [
      {
        type: 'terminal',
        id: 'surface-1',
        parentTabId: HOST_TAB,
        leafId: 'leaf-1',
        title: 'Terminal',
        status: 'ready',
        terminal: 'handle-1',
        isActive: true,
        ...(viewMode ? { viewMode } : {})
      }
    ]
  } as RuntimeMobileSessionTabsResult
}

function rebuild(existing: Partial<TerminalTab>, viewMode?: 'terminal' | 'chat'): TerminalTab {
  const localTabId = toWebTerminalSurfaceTabId(HOST_TAB)
  const existingById = new Map<string, TerminalTab>([
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: `existing` is a partial row on purpose — the mirroring path is what fills the remaining fields.
    [localTabId, { id: localTabId, ...existing } as TerminalTab]
  ])
  const [mirrored] = buildMirroredTerminalTabs(
    snapshot(viewMode),
    ENVIRONMENT,
    existingById,
    {},
    0,
    1_000
  )
  return mirrored!.tab
}

describe('buildMirroredTerminalTabs viewMode adoption', () => {
  beforeEach(() => {
    resetLocalViewModeWritesForTests()
  })

  it('adopts a host viewMode on a tab this client never wrote', () => {
    expect(rebuild({ viewMode: 'terminal' }, 'chat').viewMode).toBe('chat')
  })

  it('keeps the client value while its own write is in flight, even though the host echoes the old one', () => {
    const localTabId = toWebTerminalSurfaceTabId(HOST_TAB)
    recordLocalViewModeWrite(localTabId)
    expect(rebuild({ viewMode: 'chat' }, 'terminal').viewMode).toBe('chat')
  })

  it('adopts a differing host viewMode once this client write has settled', () => {
    const localTabId = toWebTerminalSurfaceTabId(HOST_TAB)
    const token = recordLocalViewModeWrite(localTabId)
    settleLocalViewModeWrite(localTabId, token)
    expect(rebuild({ viewMode: 'chat' }, 'terminal').viewMode).toBe('terminal')
  })

  it('keeps the client value when the host echoes that very value back', () => {
    const localTabId = toWebTerminalSurfaceTabId(HOST_TAB)
    const token = recordLocalViewModeWrite(localTabId)
    settleLocalViewModeWrite(localTabId, token)
    expect(rebuild({ viewMode: 'chat' }, 'chat').viewMode).toBe('chat')
  })

  it('ignores a superseded write settling after a newer one', () => {
    const localTabId = toWebTerminalSurfaceTabId(HOST_TAB)
    const stale = recordLocalViewModeWrite(localTabId)
    recordLocalViewModeWrite(localTabId)
    settleLocalViewModeWrite(localTabId, stale)
    // The newer write is still in flight, so its echo window stays closed to adoption.
    expect(rebuild({ viewMode: 'chat' }, 'terminal').viewMode).toBe('chat')
  })

  it('follows the host again once the write settles, so a peer change made later still lands', () => {
    const localTabId = toWebTerminalSurfaceTabId(HOST_TAB)
    const token = recordLocalViewModeWrite(localTabId)
    // A peer flips the host to 'terminal' while our write is in flight; it is held, not adopted.
    expect(rebuild({ viewMode: 'chat' }, 'terminal').viewMode).toBe('chat')
    settleLocalViewModeWrite(localTabId, token)
    expect(rebuild({ viewMode: 'chat' }, 'terminal').viewMode).toBe('terminal')
  })

  it('does not strand the tab on the echo of its own write once that write has landed', () => {
    const localTabId = toWebTerminalSurfaceTabId(HOST_TAB)
    const token = recordLocalViewModeWrite(localTabId)
    // A snapshot published before the write landed still carries the pre-write value.
    expect(rebuild({ viewMode: 'chat' }, 'terminal').viewMode).toBe('chat')
    settleLocalViewModeWrite(localTabId, token)
    // The host now reports the value this client wrote, so the tab has to land there too rather
    // than hold the 'terminal' it read in flight.
    expect(rebuild({ viewMode: 'chat' }, 'chat').viewMode).toBe('chat')
    expect(rebuild({ viewMode: 'terminal' }, 'chat').viewMode).toBe('chat')
  })
})
