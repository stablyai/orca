/**
 * Profile fixtures for a project a WSL move carried onto a host: the host's state right after it
 * imported the project, and the copy of those rows the moving desktop keeps for that host.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { makeTerminalScrollbackSnapshotRef } from '../../../src/main/terminal-scrollback-snapshots'
import { DEFAULT_LOCAL_ORCA_PROFILE_ID } from '../../../src/shared/orca-profiles'
import { ORCAD_MIGRATION_MANIFEST_VERSION } from '../../../src/shared/orcad-migration/orcad-migration-manifest-validation'
import { mutateStoppedProfileState } from './persisted-profile-state'

export const MOVED_TAB = 'moved-tab-0001'
const MOVED_LEAF = 'moved-leaf-0001'
const MOVED_GROUP = 'moved-group-0001'
const MOVED_BROWSER = 'moved-browser-0001'
const MOVED_BROWSER_PAGE = 'moved-browser-page-0001'
export const MOVED_BROWSER_URL = 'https://example.invalid/moved-docs'

type MovedOpenFile = { filePath: string; relativePath: string; dirtyDraftContent?: string }

/** The moved workspace's session rows, keyed as a session partition holds them. */
export function movedWorkspaceRows(
  worktreeId: string,
  options: {
    openFiles?: MovedOpenFile[]
    runtimeEnvironmentId?: string
    browserTab?: boolean
    /** A UUID leaf whose history the host's daemon holds, so no stored snapshot names it. */
    daemonHistoryLeafId?: string
  } = {}
): Record<string, Record<string, unknown>> {
  const files = options.openFiles ?? []
  const leafId = options.daemonHistoryLeafId ?? MOVED_LEAF
  const browser = options.browserTab !== false
  const page = {
    id: MOVED_BROWSER_PAGE,
    workspaceId: MOVED_BROWSER,
    worktreeId,
    url: MOVED_BROWSER_URL,
    title: 'Moved docs',
    loading: false,
    faviconUrl: null,
    canGoBack: false,
    canGoForward: false,
    loadError: null,
    createdAt: 1
  }
  return {
    tabsByWorktree: {
      [worktreeId]: [
        {
          id: MOVED_TAB,
          ptyId: null,
          worktreeId,
          title: 'Shell',
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: 0
        }
      ]
    },
    unifiedTabs: {
      [worktreeId]: [
        {
          id: MOVED_TAB,
          entityId: MOVED_TAB,
          groupId: MOVED_GROUP,
          worktreeId,
          contentType: 'terminal',
          label: 'Shell',
          customLabel: null,
          color: null,
          sortOrder: 0,
          createdAt: 0
        },
        ...(browser
          ? [
              {
                id: MOVED_BROWSER,
                entityId: MOVED_BROWSER,
                groupId: MOVED_GROUP,
                worktreeId,
                contentType: 'browser',
                label: 'Browser 1',
                customLabel: null,
                color: null,
                sortOrder: 1,
                createdAt: 1
              }
            ]
          : [])
      ]
    },
    browserTabsByWorktree: browser
      ? {
          [worktreeId]: [
            {
              id: MOVED_BROWSER,
              worktreeId,
              label: 'Browser 1',
              activePageId: MOVED_BROWSER_PAGE,
              pageIds: [MOVED_BROWSER_PAGE],
              url: MOVED_BROWSER_URL,
              title: 'Moved docs',
              loading: false,
              faviconUrl: null,
              canGoBack: false,
              canGoForward: false,
              loadError: null,
              createdAt: 1
            }
          ]
        }
      : {},
    browserPagesByWorkspace: browser ? { [MOVED_BROWSER]: [page] } : {},
    openFilesByWorktree:
      files.length === 0
        ? {}
        : {
            [worktreeId]: files.map((file) => ({
              filePath: file.filePath,
              relativePath: file.relativePath,
              worktreeId,
              language: 'plaintext',
              ...(options.runtimeEnvironmentId
                ? { runtimeEnvironmentId: options.runtimeEnvironmentId }
                : {}),
              ...(file.dirtyDraftContent !== undefined
                ? { dirtyDraftContent: file.dirtyDraftContent }
                : {})
            }))
          },
    tabGroups: {
      [worktreeId]: [
        {
          id: MOVED_GROUP,
          worktreeId,
          activeTabId: MOVED_TAB,
          tabOrder: browser ? [MOVED_TAB, MOVED_BROWSER] : [MOVED_TAB]
        }
      ]
    },
    activeGroupIdByWorktree: { [worktreeId]: MOVED_GROUP },
    terminalLayoutsByTabId: {
      [MOVED_TAB]: {
        root: { type: 'leaf', leafId },
        activeLeafId: leafId,
        expandedLeafId: null,
        ...(options.daemonHistoryLeafId
          ? {}
          : {
              scrollbackRefsByLeafId: {
                [MOVED_LEAF]: makeTerminalScrollbackSnapshotRef(MOVED_TAB, MOVED_LEAF)
              }
            })
      }
    }
  }
}

/** Lays `rows` over `session`, one keyed map at a time. */
export function withMovedRows(
  session: Record<string, unknown>,
  rows: Record<string, Record<string, unknown>>
): void {
  for (const [field, entries] of Object.entries(rows)) {
    const held = session[field]
    session[field] = { ...(held && typeof held === 'object' ? held : {}), ...entries }
  }
}

/**
 * The host's state right after it imported a moved project: a terminal tab whose only history is
 * a stored scrollback snapshot, with no terminal session behind it (the move strips the desktop's).
 * Drafts never reach the host: the export strips them, so `openFiles` here carry none.
 */
export function seedImportedMovedTab(
  userDataDir: string,
  worktreeId: string,
  history: string,
  options: {
    importedByWslMove?: boolean
    openFiles?: MovedOpenFile[]
    /** False as the distro's server holds it after import: no browser, so no browser tab. */
    browserTab?: boolean
  } = {}
): void {
  const ref = makeTerminalScrollbackSnapshotRef(MOVED_TAB, MOVED_LEAF)
  const roots = [userDataDir, path.join(userDataDir, 'profiles', DEFAULT_LOCAL_ORCA_PROFILE_ID)]
  for (const root of roots) {
    mkdirSync(path.join(root, 'terminal-scrollback'), { recursive: true })
    writeFileSync(path.join(root, 'terminal-scrollback', `${ref}.bin`), history)
  }
  mutateStoppedProfileState(userDataDir, (state) => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this test seeded the profile and reads only these session maps.
    const session = state.workspaceSession as Record<string, unknown>
    // Why: a headless host has no window that would restore the pane itself; keep the fixture's off it.
    Reflect.set(session, 'activeWorktreeId', null)
    if (options.importedByWslMove !== false) {
      // The receipt a committed WSL move leaves: it is what marks these panes as moved here.
      state.orcadMigrationImportReceipts = [
        {
          version: ORCAD_MIGRATION_MANIFEST_VERSION,
          migrationId: 'moved-history-move',
          manifestSha256: '0'.repeat(64),
          source: {
            kind: 'local-wsl',
            distro: 'Ubuntu',
            scopeRepoIds: [worktreeId.split('::')[0]],
            scopeFolderWorkspaceIds: [],
            generation: 1
          },
          importedAt: '2026-10-23T00:00:00.000Z',
          repositoryIds: [worktreeId.split('::')[0]],
          projectGroupIds: [],
          folderWorkspaceIds: []
        }
      ]
    }
    const openFiles = (options.openFiles ?? []).map(
      ({ dirtyDraftContent: _draft, ...file }) => file
    )
    const rows = movedWorkspaceRows(worktreeId, { openFiles, browserTab: options.browserTab })
    withMovedRows(session, rows)
  })
}

export function createMovedRepo(root: string): string {
  const repoPath = path.join(root, 'moved-repo')
  mkdirSync(repoPath)
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repoPath })
  const identity = ['-c', 'user.name=e2e', '-c', 'user.email=e2e@example.invalid']
  execFileSync('git', [...identity, 'commit', '-q', '--allow-empty', '-m', 'init'], {
    cwd: repoPath
  })
  return repoPath
}
