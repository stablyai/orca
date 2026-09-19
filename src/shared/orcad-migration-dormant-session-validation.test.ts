import { describe, expect, it } from 'vitest'
import { getDefaultWorkspaceSession } from './constants'
import {
  CLIENT_HOSTED_BROWSER_PAGE_RECORD_VERSION,
  type PersistedClientHostedBrowserPage
} from './client-hosted-browser-page-record'
import type { BrowserWorkspace } from './browser-workspace-types'
import { assertOrcadMigrationDormantWorkspaceSessionReferences } from './orcad-migration-dormant-session-validation'
import { parseOrcadMigrationClientState } from './orcad-migration-client-state'
import type { WorkspaceSessionState } from './workspace-session-state-types'

const OWNER = 'repo-1::/srv/worktree'
const BROWSER_WORKSPACE_ID = 'browser-workspace-1'

function browserWorkspace(): BrowserWorkspace {
  return {
    id: BROWSER_WORKSPACE_ID,
    worktreeId: OWNER,
    activePageId: null,
    pageIds: [],
    url: 'about:blank',
    title: 'Browser',
    loading: false,
    faviconUrl: null,
    canGoBack: false,
    canGoForward: false,
    loadError: null,
    createdAt: 1
  }
}

function clientPage(
  browserPageId: string,
  workspaceId = BROWSER_WORKSPACE_ID
): PersistedClientHostedBrowserPage {
  return {
    v: CLIENT_HOSTED_BROWSER_PAGE_RECORD_VERSION,
    browserPageId,
    workspaceId,
    browserProfileId: 'profile-1',
    url: 'https://example.test/',
    title: 'Example',
    pairedDeviceId: 'device-1',
    savedAt: 1
  }
}

function validate(session: WorkspaceSessionState): void {
  assertOrcadMigrationDormantWorkspaceSessionReferences({
    session,
    owns: (ownerKey) => ownerKey === OWNER,
    repositoryIds: new Set(['repo-1'])
  })
}

function sessionWithPages(pages: ReturnType<typeof clientPage>[]): WorkspaceSessionState {
  return {
    ...getDefaultWorkspaceSession(),
    browserTabsByWorktree: { [OWNER]: [browserWorkspace()] },
    clientHostedBrowserPagesByWorktree: { [OWNER]: pages }
  }
}

describe('dormant client-hosted browser page migration validation', () => {
  it('accepts held pages whose workspace id belongs to the transferred browser workspace', () => {
    expect(() => validate(sessionWithPages([clientPage('page-1')]))).not.toThrow()
  })

  it('rejects a page that names a browser workspace outside its owner', () => {
    expect(() => validate(sessionWithPages([clientPage('page-1', 'browser-missing')]))).toThrow(
      'orcad_migration_dormant_workspace_session_client_page_scope_invalid'
    )
  })

  it('rejects duplicate client-hosted page identities', () => {
    expect(() => validate(sessionWithPages([clientPage('page-1'), clientPage('page-1')]))).toThrow(
      'orcad_migration_dormant_workspace_session_identity_duplicate'
    )
  })

  it('accepts scoped client-owned close intents alongside transferred pages', () => {
    const session = sessionWithPages([clientPage('page-1')])
    session.clientHostedBrowserCloseIntentsByEnvironment = {
      'old-environment': [{ browserPageId: 'page-1', worktreeId: OWNER, closedAt: 10 }]
    }
    expect(() => validate(session)).not.toThrow()
  })

  it('parses migration close-intent envelopes with source environment identity', () => {
    expect(
      parseOrcadMigrationClientState({
        clientHostedBrowserCloseIntents: [
          {
            sourceEnvironmentId: 'old-environment',
            browserPageId: 'page-1',
            worktreeId: OWNER,
            closedAt: 10
          }
        ]
      })
    ).toEqual({
      clientHostedBrowserCloseIntents: [
        {
          sourceEnvironmentId: 'old-environment',
          browserPageId: 'page-1',
          worktreeId: OWNER,
          closedAt: 10
        }
      ]
    })
  })

  it('allows global browser URL history to remain client-owned', () => {
    const session = sessionWithPages([])
    session.browserUrlHistory = [
      {
        url: 'https://example.test/',
        normalizedUrl: 'https://example.test/',
        title: 'Example',
        lastVisitedAt: 10,
        visitCount: 1
      }
    ]
    expect(() => validate(session)).not.toThrow()
  })

  it('accepts markdown visibility only when it names a persisted open file', () => {
    const session = sessionWithPages([])
    session.openFilesByWorktree = {
      [OWNER]: [
        {
          filePath: '/srv/worktree/README.md',
          relativePath: 'README.md',
          worktreeId: OWNER,
          language: 'markdown'
        }
      ]
    }
    session.markdownFrontmatterVisible = { '/srv/worktree/README.md': false }
    expect(() => validate(session)).not.toThrow()
    session.markdownFrontmatterVisible = { '/srv/worktree/missing.md': false }
    expect(() => validate(session)).toThrow(
      'orcad_migration_dormant_workspace_session_markdown_scope_invalid'
    )
  })

  it('accepts a terminal layout referenced only by the unified tab model', () => {
    const session: WorkspaceSessionState = {
      ...getDefaultWorkspaceSession(),
      tabsByWorktree: {},
      unifiedTabs: {
        [OWNER]: [
          {
            id: 'terminal-tab-1',
            entityId: 'terminal-tab-1',
            groupId: 'group-1',
            worktreeId: OWNER,
            contentType: 'terminal' as const,
            label: 'Terminal',
            customLabel: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          }
        ]
      },
      terminalLayoutsByTabId: {
        'terminal-tab-1': {
          root: { type: 'leaf' as const, leafId: 'leaf-1' },
          activeLeafId: 'leaf-1',
          expandedLeafId: null
        }
      }
    }
    expect(() => validate(session)).not.toThrow()
  })
})
