import { describe, expect, it } from 'vitest'
import type { BrowserWorkspace } from './browser-workspace-types'
import { getDefaultWorkspaceSession } from './constants'
import type { Tab, TabGroup } from './tab-types'
import type { TerminalTab } from './terminal-tab-types'
import type { PersistedOpenFile, WorkspaceSessionState } from './workspace-session-state-types'
import { adoptStrandedHostPartitionSession } from './workspace-session-stranded-partition-adoption'

const WORKTREE_ID = 'repo-remote::/remote/checkout/feature'

function tab(id: string, createdAt = 1): TerminalTab {
  return {
    id,
    ptyId: `pty-${id}`,
    worktreeId: WORKTREE_ID,
    title: id,
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt
  }
}

function file(name: string, overrides: Partial<PersistedOpenFile> = {}): PersistedOpenFile {
  return {
    filePath: `/remote/checkout/feature/${name}`,
    relativePath: name,
    worktreeId: WORKTREE_ID,
    language: 'typescript',
    ...overrides
  }
}

function browser(id: string, createdAt: number): BrowserWorkspace {
  return {
    id,
    worktreeId: WORKTREE_ID,
    url: `https://example.test/${id}`,
    title: id,
    loading: false,
    faviconUrl: null,
    canGoBack: false,
    canGoForward: false,
    loadError: null,
    createdAt
  }
}

function unified(id: string, groupId: string, contentType: Tab['contentType'] = 'terminal'): Tab {
  return {
    id,
    entityId: id,
    groupId,
    worktreeId: WORKTREE_ID,
    contentType,
    label: id,
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 1
  }
}

function group(id: string, tabOrder: string[]): TabGroup {
  return { id, worktreeId: WORKTREE_ID, activeTabId: tabOrder[0] ?? null, tabOrder }
}

function session(overrides: Partial<WorkspaceSessionState>): WorkspaceSessionState {
  return { ...getDefaultWorkspaceSession(), ...overrides }
}

/** Both partitions hold terminal tabs, so the host row wins the workspace (#22503). */
function hostWon(
  base: Partial<WorkspaceSessionState>,
  host: Partial<WorkspaceSessionState>,
  options?: Parameters<typeof adoptStrandedHostPartitionSession>[2]
): WorkspaceSessionState {
  return adoptStrandedHostPartitionSession(
    session({ tabsByWorktree: { [WORKTREE_ID]: [tab('l1')] }, ...base }),
    session({ tabsByWorktree: { [WORKTREE_ID]: [tab('l1')] }, ...host }),
    options
  ).session
}

describe('adoptStrandedHostPartitionSession editor files in a host-won row', () => {
  it('keeps a base-only unsaved draft and drops a base-only clean file', () => {
    const result = hostWon(
      {
        openFilesByWorktree: {
          [WORKTREE_ID]: [file('draft.ts', { dirtyDraftContent: 'unsaved' }), file('clean.ts')]
        }
      },
      { openFilesByWorktree: { [WORKTREE_ID]: [file('host.ts')] } }
    )

    expect(
      result.openFilesByWorktree?.[WORKTREE_ID]?.map((entry) => [
        entry.relativePath,
        entry.dirtyDraftContent
      ])
    ).toEqual([
      ['host.ts', undefined],
      ['draft.ts', 'unsaved']
    ])
  })

  it('lets the host copy win a file both rows list', () => {
    const result = hostWon(
      { openFilesByWorktree: { [WORKTREE_ID]: [file('same.ts', { dirtyDraftContent: 'stale' })] } },
      { openFilesByWorktree: { [WORKTREE_ID]: [file('same.ts')] } }
    )

    expect(result.openFilesByWorktree?.[WORKTREE_ID]).toEqual([file('same.ts')])
  })

  it('treats the same path under another runtime as a different file', () => {
    const result = hostWon(
      {
        openFilesByWorktree: {
          [WORKTREE_ID]: [
            file('same.ts', { runtimeEnvironmentId: 'env-1', dirtyDraftContent: 'unsaved' })
          ]
        }
      },
      { openFilesByWorktree: { [WORKTREE_ID]: [file('same.ts')] } }
    )

    expect(
      result.openFilesByWorktree?.[WORKTREE_ID]?.map((entry) => entry.runtimeEnvironmentId)
    ).toEqual([undefined, 'env-1'])
  })

  it('does not carry a read-only file, whose draft hydration discards anyway', () => {
    const result = hostWon(
      {
        openFilesByWorktree: {
          [WORKTREE_ID]: [file('log.txt', { readOnly: true, dirtyDraftContent: 'x' })]
        }
      },
      { openFilesByWorktree: { [WORKTREE_ID]: [file('host.ts')] } }
    )

    expect(result.openFilesByWorktree?.[WORKTREE_ID]?.map((entry) => entry.relativePath)).toEqual([
      'host.ts'
    ])
  })

  it('gives a carried draft an editor entry at the end of the host group', () => {
    const draft = file('draft.ts', { dirtyDraftContent: 'unsaved' })
    const result = hostWon(
      { openFilesByWorktree: { [WORKTREE_ID]: [draft] } },
      {
        openFilesByWorktree: { [WORKTREE_ID]: [file('host.ts')] },
        unifiedTabs: {
          [WORKTREE_ID]: [
            unified('l1', 'g1'),
            { ...unified(file('host.ts').filePath, 'g1', 'editor'), sortOrder: 4 }
          ]
        },
        tabGroups: { [WORKTREE_ID]: [group('g1', ['l1', file('host.ts').filePath])] }
      }
    )

    const entry = result.unifiedTabs?.[WORKTREE_ID]?.find((tab) => tab.entityId === draft.filePath)
    expect(entry).toMatchObject({
      id: draft.filePath,
      contentType: 'editor',
      groupId: 'g1',
      worktreeId: WORKTREE_ID,
      label: 'draft.ts',
      sortOrder: 5
    })
    expect(result.tabGroups?.[WORKTREE_ID]?.[0]?.tabOrder).toEqual([
      'l1',
      file('host.ts').filePath,
      draft.filePath
    ])
  })

  it('carries a draft even when the base held no terminal tabs for the workspace', () => {
    const result = adoptStrandedHostPartitionSession(
      session({
        openFilesByWorktree: { [WORKTREE_ID]: [file('draft.ts', { dirtyDraftContent: 'x' })] }
      }),
      session({ openFilesByWorktree: { [WORKTREE_ID]: [file('host.ts')] } })
    ).session

    expect(result.openFilesByWorktree?.[WORKTREE_ID]?.map((entry) => entry.relativePath)).toEqual([
      'host.ts',
      'draft.ts'
    ])
  })

  it('leaves a contested id to its own base row', () => {
    const draft = file('draft.ts', { dirtyDraftContent: 'unsaved' })
    const result = hostWon(
      { openFilesByWorktree: { [WORKTREE_ID]: [draft] } },
      { openFilesByWorktree: { [WORKTREE_ID]: [file('host.ts')] } },
      { contestedSessionKeys: new Set([WORKTREE_ID]) }
    )

    expect(result.openFilesByWorktree?.[WORKTREE_ID]).toEqual([draft])
  })
})

describe('adoptStrandedHostPartitionSession browser workspaces in a host-won row', () => {
  it('keeps a base-only browser created after the host evidence and drops older residue', () => {
    const result = hostWon(
      { browserTabsByWorktree: { [WORKTREE_ID]: [browser('old', 5), browser('new', 30)] } },
      {
        tabsByWorktree: { [WORKTREE_ID]: [tab('l1', 10)] },
        browserTabsByWorktree: { [WORKTREE_ID]: [browser('host', 20)] }
      }
    )

    expect(result.browserTabsByWorktree?.[WORKTREE_ID]?.map((entry) => entry.id)).toEqual([
      'host',
      'new'
    ])
  })

  it('lets the host copy win a browser both rows list', () => {
    const result = hostWon(
      { browserTabsByWorktree: { [WORKTREE_ID]: [{ ...browser('b1', 30), title: 'stale' }] } },
      { browserTabsByWorktree: { [WORKTREE_ID]: [browser('b1', 20)] } }
    )

    expect(result.browserTabsByWorktree?.[WORKTREE_ID]?.map((entry) => entry.title)).toEqual(['b1'])
  })

  it("carries a kept browser's own unified entry and builds none it did not have", () => {
    const result = hostWon(
      {
        browserTabsByWorktree: { [WORKTREE_ID]: [browser('own', 30), browser('bare', 31)] },
        unifiedTabs: { [WORKTREE_ID]: [unified('own', 'g-local', 'browser')] }
      },
      {
        browserTabsByWorktree: { [WORKTREE_ID]: [browser('host', 20)] },
        unifiedTabs: { [WORKTREE_ID]: [unified('l1', 'g1'), unified('host', 'g1', 'browser')] },
        tabGroups: { [WORKTREE_ID]: [group('g1', ['l1', 'host'])] }
      }
    )

    expect(
      result.unifiedTabs?.[WORKTREE_ID]?.map((entry) => [entry.entityId, entry.groupId])
    ).toEqual([
      ['l1', 'g1'],
      ['host', 'g1'],
      ['own', 'g1']
    ])
  })
})

describe('adoptStrandedHostPartitionSession unified group for carried entries', () => {
  it('creates the group a carried entry is filed under when the workspace has none', () => {
    const result = adoptStrandedHostPartitionSession(
      session({ tabsByWorktree: { [WORKTREE_ID]: [tab('live-local')] }, unifiedTabs: {} }),
      session({
        tabsByWorktree: { [WORKTREE_ID]: [tab('h1')] },
        unifiedTabs: { [WORKTREE_ID]: [] },
        tabGroups: {}
      })
    ).session

    const groupId = `carried:${WORKTREE_ID}`
    expect(result.unifiedTabs?.[WORKTREE_ID]?.map((entry) => entry.groupId)).toEqual([
      groupId,
      groupId
    ])
    expect(result.tabGroups?.[WORKTREE_ID]).toEqual([
      {
        id: groupId,
        worktreeId: WORKTREE_ID,
        activeTabId: 'h1',
        tabOrder: ['h1', 'live-local'],
        recentTabIds: ['h1']
      }
    ])
    expect(result.activeGroupIdByWorktree?.[WORKTREE_ID]).toBe(groupId)
  })

  it('files carried entries under an existing group when the active pointer is stale', () => {
    const result = adoptStrandedHostPartitionSession(
      session({ tabsByWorktree: { [WORKTREE_ID]: [tab('live-local')] }, unifiedTabs: {} }),
      session({
        tabsByWorktree: { [WORKTREE_ID]: [tab('h1')] },
        unifiedTabs: { [WORKTREE_ID]: [unified('h1', 'g1')] },
        tabGroups: { [WORKTREE_ID]: [group('g1', ['h1'])] },
        activeGroupIdByWorktree: { [WORKTREE_ID]: 'gone' }
      })
    ).session

    expect(
      result.unifiedTabs?.[WORKTREE_ID]?.find((entry) => entry.entityId === 'live-local')?.groupId
    ).toBe('g1')
    expect(result.tabGroups?.[WORKTREE_ID]?.[0]?.tabOrder).toEqual(['h1', 'live-local'])
  })

  it('does not invent tab groups for a session that hydrates in the legacy format', () => {
    const result = adoptStrandedHostPartitionSession(
      session({ tabsByWorktree: { [WORKTREE_ID]: [tab('live-local')] }, unifiedTabs: {} }),
      session({ tabsByWorktree: { [WORKTREE_ID]: [tab('h1')] } })
    ).session

    expect(result.tabGroups).toBeUndefined()
    expect(result.activeGroupIdByWorktree).toBeUndefined()
  })
})
