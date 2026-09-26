import { describe, expect, it } from 'vitest'
import { MAX_RECOVERY_PRESENTATION_WORKSPACES } from '../../../shared/cross-machine-recovery-presentation-types'
import type { ExecutionHostId } from '../../../shared/execution-host'
import { CrossMachineRecoveryPresentationPublishParams } from '../../../shared/rpc-contract/cross-machine-recovery-params'
import { makePaneKey } from '../../../shared/stable-pane-id'
import type { Tab } from '../../../shared/tab-types'
import type { TerminalTab } from '../../../shared/terminal-tab-types'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import {
  projectCrossMachineRecoveryPresentation,
  type PresentationProjectionInput
} from './cross-machine-recovery-presentation-projection'

const LEAF_1 = '11111111-1111-4111-8111-111111111111'
const LEAF_2 = '22222222-2222-4222-8222-222222222222'

const HOSTS: Record<string, ExecutionHostId> = {
  'wt-local': 'local',
  'folder:fw-1': 'local',
  'wt-a': 'runtime:A',
  'wt-b': 'runtime:B',
  'wt-ssh': 'ssh:box'
}

function terminalTab(id: string, worktreeId: string, startupCwd?: string): TerminalTab {
  return {
    id,
    ptyId: 'pty-live',
    worktreeId,
    title: 'zsh',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1,
    generation: 3,
    ...(startupCwd ? { startupCwd } : {})
  }
}

function unifiedTab(id: string, entityId: string, contentType: Tab['contentType']): Tab {
  return {
    id,
    entityId,
    groupId: 'g1',
    worktreeId: 'wt-local',
    executionHostId: 'local',
    contentType,
    label: id,
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 1
  }
}

function session(): WorkspaceSessionState {
  return {
    activeRepoId: 'repo',
    activeWorktreeId: 'wt-local',
    activeTabId: 'term-1',
    tabsByWorktree: {
      'wt-local': [terminalTab('term-1', 'wt-local', '/repo/wt-local/packages/app')],
      'folder:fw-1': [terminalTab('term-f', 'folder:fw-1')],
      'wt-a': [terminalTab('term-a', 'wt-a')],
      'wt-b': [terminalTab('term-b', 'wt-b')],
      'wt-ssh': [terminalTab('term-s', 'wt-ssh')]
    },
    terminalLayoutsByTabId: {
      'term-1': {
        root: {
          type: 'split',
          direction: 'vertical',
          ratio: 0.3,
          first: { type: 'leaf', leafId: LEAF_1 },
          second: { type: 'leaf', leafId: LEAF_2 }
        },
        activeLeafId: LEAF_2,
        expandedLeafId: null,
        ptyIdsByLeafId: { [LEAF_1]: 'pty-1' },
        buffersByLeafId: { [LEAF_1]: 'scrollback-secret' },
        scrollbackRefsByLeafId: { [LEAF_1]: 'ref-secret' },
        titlesByLeafId: { [LEAF_2]: 'server' }
      }
    },
    localOnlyScrollbackByTabId: { 'term-1': { [LEAF_1]: 'local-scrollback-secret' } },
    unifiedTabs: {
      'wt-local': [
        unifiedTab('term-1', 'term-1', 'terminal'),
        unifiedTab('/repo/wt-local/src/a.ts', '/repo/wt-local/src/a.ts', 'editor')
      ]
    },
    tabGroups: {
      'wt-local': [
        { id: 'g1', worktreeId: 'wt-local', activeTabId: 'term-1', tabOrder: ['term-1'] }
      ]
    },
    activeGroupIdByWorktree: { 'wt-local': 'g1' },
    openFilesByWorktree: {
      'wt-local': [
        {
          filePath: '/repo/wt-local/src/a.ts',
          relativePath: 'src/a.ts',
          worktreeId: 'wt-local',
          language: 'typescript',
          dirtyDraftContent: 'draft-secret'
        },
        {
          filePath: '/etc/hosts',
          relativePath: '/etc/hosts',
          worktreeId: 'wt-local',
          language: 'plaintext',
          externalSshTargetId: 'box'
        },
        {
          filePath: '/other/x.ts',
          relativePath: '../../other/x.ts',
          worktreeId: 'wt-local',
          language: 'typescript'
        }
      ]
    },
    activeFileIdByWorktree: { 'wt-local': '/repo/wt-local/src/a.ts' },
    browserUrlHistory: [
      {
        url: 'https://history-secret.example',
        normalizedUrl: 'x',
        title: 't',
        lastVisitedAt: 1,
        visitCount: 1
      }
    ]
  }
}

function input(overrides: Partial<PresentationProjectionInput> = {}): PresentationProjectionInput {
  return {
    session: session(),
    hostIdByWorktreeId: (key) => HOSTS[key] ?? 'local',
    catalog: {
      pathFor: (key) => (key === 'wt-local' ? '/repo/wt-local' : null),
      instanceIdFor: (worktreeId) => (worktreeId === 'wt-local' ? 'instance-1' : undefined)
    },
    windowFocused: true,
    inputFor: () => ({
      msSinceHumanInput: null,
      msSinceHumanFocus: null,
      msSinceHumanInputByPaneKey: {}
    }),
    ...overrides
  }
}

describe('projectCrossMachineRecoveryPresentation', () => {
  it('routes workspaces to local and each runtime host, excluding ssh', () => {
    const byHost = projectCrossMachineRecoveryPresentation(input())
    expect([...byHost.keys()].sort()).toEqual(['local', 'runtime:A', 'runtime:B'])
    expect(byHost.get('local')?.workspaces.map((entry) => entry.workspace)).toEqual([
      { kind: 'worktree', worktreeId: 'wt-local', instanceId: 'instance-1' },
      { kind: 'folder', folderWorkspaceId: 'fw-1' }
    ])
    expect(byHost.get('runtime:A')?.workspaces.map((entry) => entry.workspace)).toEqual([
      { kind: 'worktree', worktreeId: 'wt-a' }
    ])
  })

  it('strips scrollback, drafts, pty incarnations and browser history', () => {
    const local = projectCrossMachineRecoveryPresentation(input()).get('local')
    const serialized = JSON.stringify(local)
    for (const secret of [
      'scrollback-secret',
      'ref-secret',
      'draft-secret',
      'history-secret',
      'pty-'
    ]) {
      expect(serialized).not.toContain(secret)
    }
    const view = local?.workspaces[0].view
    expect(view?.terminalTabs[0]).not.toHaveProperty('generation')
    expect(view?.tabs[0]).not.toHaveProperty('worktreeId')
    expect(view?.groups[0]).not.toHaveProperty('worktreeId')
  })

  it('keeps multi-pane ratios, titles and the focused pane', () => {
    const [entry] = projectCrossMachineRecoveryPresentation(input()).get('local')?.workspaces ?? []
    expect(entry.view.terminalLayouts['term-1']).toEqual({
      root: {
        type: 'split',
        direction: 'vertical',
        ratio: 0.3,
        first: { type: 'leaf', leafId: LEAF_1 },
        second: { type: 'leaf', leafId: LEAF_2 }
      },
      activeLeafId: LEAF_2,
      expandedLeafId: null,
      titlesByLeafId: { [LEAF_2]: 'server' }
    })
    expect(entry.view.startupCwdRelative).toEqual({ 'term-1': 'packages/app' })
    expect(entry.focus).toEqual({
      isActiveWorkspace: true,
      focusedTabId: 'term-1',
      focusedLeafId: LEAF_2,
      focusedPaneKey: makePaneKey('term-1', LEAF_2),
      windowFocused: true
    })
  })

  it('exports only in-workspace editor paths', () => {
    const [entry] = projectCrossMachineRecoveryPresentation(input()).get('local')?.workspaces ?? []
    expect(entry.view.editors).toEqual([{ relativePath: 'src/a.ts', language: 'typescript' }])
    expect(entry.view.activeEditorRelativePath).toBe('src/a.ts')
  })

  it('produces params the host publish schema accepts', () => {
    for (const snapshot of projectCrossMachineRecoveryPresentation(input()).values()) {
      const parsed = CrossMachineRecoveryPresentationPublishParams.safeParse({
        clientInstanceId: 'client-1',
        clientName: 'Laptop',
        clientRevision: 1,
        workspaces: snapshot.workspaces
      })
      expect(parsed.success).toBe(true)
    }
  })

  it('truncates deterministically over the workspace cap, most recent input first', () => {
    const state = session()
    for (let i = 0; i < 70; i++) {
      const id = `wt-many-${String(i).padStart(2, '0')}`
      state.tabsByWorktree[id] = [terminalTab(`term-many-${i}`, id)]
    }
    const projection = input({
      session: state,
      hostIdByWorktreeId: (key) => (key.startsWith('wt-many-') ? 'runtime:A' : 'local'),
      inputFor: (key) => ({
        msSinceHumanInput: key === 'wt-many-69' ? 10 : null,
        msSinceHumanFocus: null,
        msSinceHumanInputByPaneKey: {}
      })
    })
    const first = projectCrossMachineRecoveryPresentation(projection).get('runtime:A')
    const second = projectCrossMachineRecoveryPresentation(projection).get('runtime:A')
    expect(first).toEqual(second)
    expect(first?.truncated).toBe(true)
    expect(first?.workspaces).toHaveLength(MAX_RECOVERY_PRESENTATION_WORKSPACES)
    const ids = first?.workspaces.map((entry) =>
      entry.workspace.kind === 'worktree' ? entry.workspace.worktreeId : null
    )
    expect(ids?.slice(0, 2)).toEqual(['wt-many-69', 'wt-many-00'])
    expect(ids?.at(-1)).toBe('wt-many-62')
  })

  it('sheds inactive browser pages from an oversized view instead of dropping it', () => {
    const state = session()
    state.browserTabsByWorktree = {
      'wt-local': [
        {
          id: 'bw-1',
          worktreeId: 'wt-local',
          activePageId: 'page-0',
          url: '',
          title: '',
          loading: false,
          faviconUrl: null,
          canGoBack: false,
          canGoForward: false,
          loadError: null,
          createdAt: 1
        }
      ]
    }
    state.browserPagesByWorkspace = {
      'bw-1': Array.from({ length: 100 }, (_, index) => ({
        id: `page-${index}`,
        workspaceId: 'bw-1',
        worktreeId: 'wt-local',
        url: `https://example.com/${'x'.repeat(1_000)}/${index}`,
        title: `Page ${index}`,
        loading: false,
        faviconUrl: null,
        canGoBack: false,
        canGoForward: false,
        loadError: null,
        createdAt: 1
      }))
    }
    const local = projectCrossMachineRecoveryPresentation(input({ session: state })).get('local')
    expect(local?.truncated).toBe(true)
    expect(local?.workspaces[0].view.browsers[0].pages.map((page) => page.id)).toEqual(['page-0'])
  })
})
