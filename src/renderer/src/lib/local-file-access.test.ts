import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Repo } from '../../../shared/repo-types'
import type { Worktree } from '../../../shared/worktree/types'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../shared/constants'
import { folderWorkspaceKey } from '../../../shared/workspace-scope'
import { useAppStore } from '@/store'
import { editorTabDocumentFolderAccess, editorTabFileAccess } from './local-file-access'

const initialState = useAppStore.getInitialState()

function makeRepo(overrides: Partial<Repo> & { id: string; path: string }): Repo {
  return { displayName: 'repo', badgeColor: '#000', addedAt: 0, ...overrides }
}

function makeWorktree(overrides: Partial<Worktree> & { id: string; repoId: string }): Worktree {
  return {
    path: '/Users/me/project',
    head: 'abc123',
    branch: 'refs/heads/main',
    isBare: false,
    isMainWorktree: true,
    displayName: 'project',
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    ...overrides
  }
}

const localWorktreeId = 'repo-local::/Users/me/project'

type TabFileAccessFields = Parameters<typeof editorTabFileAccess>[1]

function accessKind(file: TabFileAccessFields): string | undefined {
  return editorTabFileAccess(useAppStore.getState(), file)?.kind
}

describe('editorTabFileAccess', () => {
  beforeEach(() => {
    useAppStore.setState({
      repos: [
        makeRepo({ id: 'repo-local', path: '/Users/me/project' }),
        makeRepo({ id: 'repo-ssh', path: '/work/project', connectionId: 'ssh-1' })
      ],
      worktreesByRepo: {
        'repo-local': [makeWorktree({ id: localWorktreeId, repoId: 'repo-local' })]
      }
    })
  })

  afterEach(() => {
    useAppStore.setState(initialState, true)
  })

  it.each<[string, TabFileAccessFields, string | undefined]>([
    [
      'a floating-workspace tab stored relative to ~',
      {
        filePath: '/Users/me/notes.txt',
        relativePath: 'notes.txt',
        worktreeId: FLOATING_TERMINAL_WORKTREE_ID
      },
      'user-file'
    ],
    [
      'a local tab stored by absolute path',
      { filePath: '/tmp/audit.md', relativePath: '/tmp/audit.md', worktreeId: localWorktreeId },
      'user-file'
    ],
    [
      'a project link opened by its absolute path because it leads out of the project',
      {
        filePath: '/Users/me/project/docs/link.md',
        relativePath: '/Users/me/project/docs/link.md',
        worktreeId: localWorktreeId
      },
      'user-file'
    ],
    [
      'an AI Vault log tab in an SSH workspace',
      {
        filePath: '/Users/me/.codex/session.jsonl',
        relativePath: '/Users/me/.codex/session.jsonl',
        worktreeId: 'repo-ssh::/work/project',
        readOnly: true,
        liveTail: true
      },
      'user-file'
    ],
    [
      'a project tab, which stays inside its root',
      { filePath: '/Users/me/project/a.ts', relativePath: 'a.ts', worktreeId: localWorktreeId },
      undefined
    ],
    [
      'an absolute tab owned by an SSH workspace',
      { filePath: '/work/x.md', relativePath: '/work/x.md', worktreeId: 'repo-ssh::/work/project' },
      undefined
    ],
    [
      'an absolute tab pinned to an SSH host',
      {
        filePath: '/work/x.md',
        relativePath: '/work/x.md',
        worktreeId: localWorktreeId,
        externalSshTargetId: 'ssh-1'
      },
      undefined
    ],
    [
      'a floating tab owned by a remote runtime',
      {
        filePath: '/Users/me/notes.txt',
        relativePath: 'notes.txt',
        worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
        runtimeEnvironmentId: 'runtime-1'
      },
      undefined
    ],
    [
      'an absolute tab whose owner has not loaded',
      {
        filePath: '/work/x.md',
        relativePath: '/work/x.md',
        worktreeId: 'repo-missing::/work/other'
      },
      undefined
    ],
    [
      'an absolute tab in a folder workspace with an unknown host',
      {
        filePath: '/home/remote/notes.md',
        relativePath: '/home/remote/notes.md',
        worktreeId: folderWorkspaceKey('fw-missing')
      },
      undefined
    ]
  ])('%s', (_label, file, expected) => {
    expect(accessKind(file)).toBe(expected)
  })
})

describe('editorTabDocumentFolderAccess', () => {
  beforeEach(() => {
    useAppStore.setState({
      repos: [
        makeRepo({ id: 'repo-local', path: '/Users/me/project' }),
        makeRepo({ id: 'repo-ssh', path: '/work/project', connectionId: 'ssh-1' })
      ],
      worktreesByRepo: {
        'repo-local': [makeWorktree({ id: localWorktreeId, repoId: 'repo-local' })]
      }
    })
  })

  afterEach(() => {
    useAppStore.setState(initialState, true)
  })

  it('declares the file itself for writes on a local user-named tab', () => {
    expect(
      editorTabDocumentFolderAccess(useAppStore.getState(), {
        filePath: '/Users/me/notes.md',
        relativePath: 'notes.md',
        worktreeId: FLOATING_TERMINAL_WORKTREE_ID
      })
    ).toEqual({ kind: 'document-folder', documentPath: '/Users/me/notes.md' })
  })

  it.each<[string, TabFileAccessFields]>([
    [
      'a project tab',
      { filePath: '/Users/me/project/a.md', relativePath: 'a.md', worktreeId: localWorktreeId }
    ],
    [
      'an absolute tab owned by an SSH workspace',
      { filePath: '/work/x.md', relativePath: '/work/x.md', worktreeId: 'repo-ssh::/work/project' }
    ],
    [
      'an AI Vault log tab',
      {
        filePath: '/Users/me/.codex/session.jsonl',
        relativePath: '/Users/me/.codex/session.jsonl',
        worktreeId: 'repo-ssh::/work/project',
        readOnly: true,
        liveTail: true
      }
    ]
  ])('grants no folder writes to %s', (_label, file) => {
    expect(editorTabDocumentFolderAccess(useAppStore.getState(), file)).toBeUndefined()
  })
})

// Why a ratchet: a content-driven reader that adopted user-file would bring back the round-1 leak.
// These scans only see the two ways a renderer file can produce user-file today, by name and by
// pattern: building user-file access directly, and opening a tab the tab rule reads as user-named. They
// cannot see a decision laundered through props or a helper, so they are a tripwire for review, not
// a proof; a branded user-named path type is the follow-up that would make it one.
const USER_NAMED_ACCESS_IMPORTERS = [
  'components/browser-pane/describe-page/browser-artifact-upload.ts',
  'components/native-chat/use-native-chat-external-attachments.ts',
  'components/sidebar/useSidebarProjectDrop.ts',
  'hooks/composer-state/attachment-drop-state.ts',
  'lib/local-file-access.ts',
  'lib/user-opened-local-path.ts'
]

// Files whose openFile call can store relativePath === filePath (read and saved as user-named by
// the tab rule) or open a floating-workspace tab. The scan matches by value, so a few listed files
// only look like it (their relativePath is genuinely relative); review each new entry by hand.
// Files that build write access beside an opened document; each must derive it from the tab rule.
const DOCUMENT_FOLDER_ACCESS_BUILDERS = [
  'components/editor/editor-header-file-rename.ts',
  'components/editor/rich-markdown-image-insert.ts',
  'components/tab-bar/EditorFileTab.tsx',
  'lib/execute-open-editor-path-move.ts',
  'lib/local-file-access.ts'
]

const USER_NAMED_TAB_OPENERS = [
  'components/browser-pane/navigate/navigate-browser-page-url.ts',
  'components/editor/markdown-preview-link-actions.ts',
  'components/floating-terminal/use-floating-terminal-create-actions.ts',
  'components/quick-open-file-navigation.ts',
  'components/right-sidebar/ai-vault-session-log-open.ts',
  'components/right-sidebar/source-control/notes/use-note-opening.ts',
  'components/right-sidebar/useFileExplorerHandlers.ts',
  'components/settings/KeybindingsFileActions.tsx',
  'components/tab-bar/tab-create-entry-absolute-file.ts',
  'components/terminal-pane/terminal-file-open-routing.ts',
  'hooks/useGlobalFileDrop.ts',
  'lib/floating-workspace-tab-creation.ts',
  'lib/open-document-in-floating-workspace.ts',
  'store/slices/editor/actions/markdown-link-action.ts'
]

function collectSourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      return collectSourceFiles(full)
    }
    return /\.tsx?$/.test(entry) &&
      !/\.test\.tsx?$/.test(entry) &&
      !/test-(harness|fixture)/.test(entry)
      ? [full]
      : []
  })
}

function opensUserNamedTabs(source: string): boolean {
  if (!/\bopenFile\(/.test(source)) {
    return false
  }
  if (source.includes('FLOATING_TERMINAL_WORKTREE_ID')) {
    return true
  }
  const filePathValues = [...source.matchAll(/\bfilePath:\s*([\w.]+)/g)]
    .map((match) => match[1])
    .filter((value) => value !== 'string')
  if (/\bfilePath,/.test(source)) {
    filePathValues.push('filePath')
  }
  const relativePathValues = [
    ...source.matchAll(/\brelativePath(?::|\s*=)\s*([\s\S]*?)(?:,\s*\n|\n\s*[})])/g)
  ].map((match) => match[1])
  return relativePathValues.some((value) =>
    filePathValues.some((filePath) =>
      new RegExp(`(^|[^\\w.])${filePath.replace(/\./g, '\\.')}($|[^\\w.])`).test(value)
    )
  )
}

function rendererFilesMatching(test: (source: string) => boolean): string[] {
  const rendererRoot = resolve(__dirname, '..')
  return collectSourceFiles(rendererRoot)
    .filter((file) => test(readFileSync(file, 'utf8')))
    .map((file) => relative(rendererRoot, file).split('\\').join('/'))
    .sort()
}

describe('user-named file access ratchet', () => {
  it('lists every file that builds user-file access', () => {
    expect(
      rendererFilesMatching((source) => /\buserNamedFileAccess\b|kind: 'user-file'/.test(source))
    ).toEqual(USER_NAMED_ACCESS_IMPORTERS)
  })

  it('lists every file that builds document-folder write access', () => {
    expect(
      rendererFilesMatching((source) =>
        /\b(editorTab)?[dD]ocumentFolderAccess\b|kind: 'document-folder'/.test(source)
      )
    ).toEqual(DOCUMENT_FOLDER_ACCESS_BUILDERS)
  })

  it('lists every file that can open a tab read as user-named', () => {
    expect(rendererFilesMatching(opensUserNamedTabs)).toEqual(USER_NAMED_TAB_OPENERS)
  })
})
