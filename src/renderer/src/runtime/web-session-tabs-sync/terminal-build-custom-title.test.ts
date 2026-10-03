import { describe, expect, it } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../../../shared/runtime-types'
import type { TerminalLayoutSnapshot, TerminalTab } from '../../../../shared/terminal-tab-types'
import { toWebTerminalSurfaceTabId } from '../../../../shared/terminal-surface-id'
import { buildMirroredTerminalTabs } from './terminal-build'

const WT = 'repo1::/path/wt1'
const HOST_TAB_ID = 'host-tab-1'
const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const SURFACE_ID = `${HOST_TAB_ID}::${LEAF_ID}`
const LOCAL_TAB_ID = toWebTerminalSurfaceTabId(HOST_TAB_ID)

function makeSnapshot(
  surfaceOverrides: Record<string, unknown> = {}
): RuntimeMobileSessionTabsResult {
  return {
    worktree: WT,
    publicationEpoch: 'host-epoch-1',
    snapshotVersion: 1,
    activeGroupId: 'g1',
    activeTabId: SURFACE_ID,
    activeTabType: 'terminal',
    tabs: [
      {
        type: 'terminal',
        id: SURFACE_ID,
        title: 'Terminal',
        parentTabId: HOST_TAB_ID,
        leafId: LEAF_ID,
        isActive: true,
        status: 'ready',
        terminal: 'terminal-1',
        ...surfaceOverrides
      } as RuntimeMobileSessionTabsResult['tabs'][number]
    ]
  }
}

function makeExisting(customTitle: string | null): Map<string, TerminalTab> {
  return new Map([
    [
      LOCAL_TAB_ID,
      {
        id: LOCAL_TAB_ID,
        ptyId: null,
        worktreeId: WT,
        title: 'Terminal',
        customTitle,
        color: null,
        sortOrder: 0,
        createdAt: 1
      }
    ]
  ])
}

function mirror(
  snapshot: RuntimeMobileSessionTabsResult,
  existing?: Map<string, TerminalTab>
): TerminalTab {
  const [mirrored] = buildMirroredTerminalTabs(
    snapshot,
    'web-env-1',
    existing ?? new Map(),
    {} as Record<string, TerminalLayoutSnapshot>,
    0,
    1_700_000_000_000
  )
  return mirrored!.tab
}

describe('buildMirroredTerminalTabs customTitle adoption', () => {
  it('a fresh browser adopts the host-published customTitle', () => {
    const tab = mirror(makeSnapshot({ customTitle: 'my rename' }))
    expect(tab.customTitle).toBe('my rename')
  })

  it('a fresh browser with no host rename has null customTitle', () => {
    const tab = mirror(makeSnapshot())
    expect(tab.customTitle).toBeNull()
  })

  it('host rename wins over a stale local value', () => {
    const tab = mirror(makeSnapshot({ customTitle: 'host rename' }), makeExisting('stale'))
    expect(tab.customTitle).toBe('host rename')
  })

  it('without a host rename the local rename is retained', () => {
    const tab = mirror(makeSnapshot(), makeExisting('local rename'))
    expect(tab.customTitle).toBe('local rename')
  })
})
