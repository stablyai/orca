import { describe, expect, it } from 'vitest'
import type { TerminalTab } from '../../../../shared/types'
import type { AppState } from '@/store/types'
import {
  resolveNativeChatFileLink,
  resolveNativeChatFileLinkContext,
  type NativeChatFileLinkContext
} from './native-chat-file-link'

function terminalTab(overrides: Partial<TerminalTab> = {}): TerminalTab {
  return {
    id: 'tab-1',
    ptyId: null,
    worktreeId: 'wt-1',
    title: 'Terminal 1',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 0,
    ...overrides
  }
}

function state(overrides: Partial<AppState> = {}): AppState {
  return {
    folderWorkspaces: [],
    getKnownWorktreeById: (worktreeId: string) =>
      worktreeId === 'wt-1' ? ({ id: 'wt-1', path: '/repo/worktree' } as never) : undefined,
    projectGroups: [],
    repos: [],
    settings: { activeRuntimeEnvironmentId: null },
    tabsByWorktree: {
      'wt-1': [terminalTab()]
    },
    worktreesByRepo: {
      repo: [{ id: 'wt-1', repoId: 'repo', path: '/repo/worktree' } as never]
    },
    ...overrides
  } as AppState
}

const context: NativeChatFileLinkContext = {
  worktreeId: 'wt-1',
  worktreePath: '/repo/worktree',
  runtimeEnvironmentId: null
}

describe('resolveNativeChatFileLinkContext', () => {
  it('returns the owner worktree path and runtime for a native chat terminal tab', () => {
    expect(
      resolveNativeChatFileLinkContext(
        state({
          settings: { activeRuntimeEnvironmentId: 'env-1' } as AppState['settings']
        }),
        'tab-1'
      )
    ).toEqual({
      worktreeId: 'wt-1',
      worktreePath: '/repo/worktree',
      runtimeEnvironmentId: 'env-1'
    })
  })

  it('returns null when the terminal tab has no worktree owner', () => {
    expect(resolveNativeChatFileLinkContext(state({ tabsByWorktree: {} }), 'tab-1')).toBeNull()
  })

  it('falls back to repo-scoped worktrees when a known worktree has no path', () => {
    expect(
      resolveNativeChatFileLinkContext(
        state({
          getKnownWorktreeById: () => ({ id: 'wt-1' }) as never,
          worktreesByRepo: {
            repo: [{ id: 'wt-1', repoId: 'repo', path: '/repo/fallback' } as never]
          }
        }),
        'tab-1'
      )
    ).toEqual({
      worktreeId: 'wt-1',
      worktreePath: '/repo/fallback',
      runtimeEnvironmentId: null
    })
  })
})

describe('resolveNativeChatFileLink', () => {
  it('resolves repo-relative file links against the chat worktree', () => {
    expect(resolveNativeChatFileLink('docs/guide.md', context)).toEqual({
      absolutePath: '/repo/worktree/docs/guide.md',
      line: null,
      column: null
    })
  })

  it('resolves explicit hrefs for non-markdown file types', () => {
    expect(resolveNativeChatFileLink('src/App.tsx#L42', context)).toEqual({
      absolutePath: '/repo/worktree/src/App.tsx',
      line: 42,
      column: null
    })
    expect(resolveNativeChatFileLink('package.json', context)).toEqual({
      absolutePath: '/repo/worktree/package.json',
      line: null,
      column: null
    })
    expect(resolveNativeChatFileLink('assets/logo.png?raw=true', context)).toEqual({
      absolutePath: '/repo/worktree/assets/logo.png',
      line: null,
      column: null
    })
    expect(resolveNativeChatFileLink('CODEOWNERS', context)).toEqual({
      absolutePath: '/repo/worktree/CODEOWNERS',
      line: null,
      column: null
    })
  })

  it('preserves terminal-style line and column suffixes', () => {
    expect(resolveNativeChatFileLink('/repo/worktree/src/main.ts:12:4', context)).toEqual({
      absolutePath: '/repo/worktree/src/main.ts',
      line: 12,
      column: 4
    })
  })

  it('resolves encoded file URIs', () => {
    expect(resolveNativeChatFileLink('file:///repo/worktree/My%20File.md#L7', context)).toEqual({
      absolutePath: '/repo/worktree/My File.md',
      line: 7,
      column: null
    })
  })

  it('decodes escaped reserved characters in repo-relative hrefs', () => {
    expect(resolveNativeChatFileLink('docs/Setup%20%231.md#L3', context)).toEqual({
      absolutePath: '/repo/worktree/docs/Setup #1.md',
      line: 3,
      column: null
    })
  })

  it('ignores http links so normal markdown navigation can handle them', () => {
    expect(resolveNativeChatFileLink('https://example.com/docs/guide.md', context)).toBeNull()
  })
})
