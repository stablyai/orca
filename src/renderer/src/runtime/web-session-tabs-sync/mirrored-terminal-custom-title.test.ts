import { describe, expect, it } from 'vitest'
import type {
  RuntimeMobileSessionTabsResult,
  RuntimeMobileSessionTerminalTab
} from '../../../../shared/runtime-types'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import { resolveTerminalTabTitle } from '../../../../shared/tab-title-resolution'
import { buildMirroredTerminalTabs } from './terminal-build'
import { toWebTerminalSurfaceTabId } from '../../../../shared/terminal-surface-id'

// #29975: a resumed Codex tab carries this client's saved-session title, which outranks the
// host's live title. A host rename only shows once it arrives as the tab's manual name.
const HOST_TAB = 'host-tab-1'
const LOCAL_TAB = toWebTerminalSurfaceTabId(HOST_TAB)
const SAVED_SESSION = { agent: 'codex', sessionId: 's-1', title: 'cutec binding step2' } as const

function rebuild(
  surface: Partial<RuntimeMobileSessionTerminalTab>,
  existing: Partial<TerminalTab>
): TerminalTab {
  const snapshot: RuntimeMobileSessionTabsResult = {
    worktree: 'repo-1::wt',
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
        title: 'Codex · 绑定实现',
        status: 'ready',
        terminal: 'handle-1',
        isActive: true,
        ...surface
      }
    ]
  }
  const existingById = new Map<string, TerminalTab>([
    [
      LOCAL_TAB,
      {
        id: LOCAL_TAB,
        ptyId: null,
        worktreeId: 'repo-1::wt',
        title: 'old',
        customTitle: null,
        color: null,
        sortOrder: 0,
        createdAt: 1,
        aiVaultTitle: SAVED_SESSION,
        ...existing
      }
    ]
  ])
  return buildMirroredTerminalTabs(snapshot, 'env-1', existingById, {}, {}, 0, 1_000)[0]!.tab
}

describe('mirrored terminal manual name', () => {
  it("shows the host's manual name over the saved-session title", () => {
    const tab = rebuild({ customTitle: 'Codex · 绑定实现' }, {})
    expect(tab.customTitle).toBe('Codex · 绑定实现')
    expect(resolveTerminalTabTitle(tab, true)).toBe('Codex · 绑定实现')
  })

  it("drops this client's name when the host reports none", () => {
    expect(rebuild({ customTitle: null }, { customTitle: '绑定' }).customTitle).toBeNull()
  })

  it("keeps this client's name when an older host publishes no manual name", () => {
    expect(rebuild({}, { customTitle: '绑定' }).customTitle).toBe('绑定')
  })
})
