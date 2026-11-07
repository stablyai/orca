// @vitest-environment happy-dom
import { cleanup, render, screen, fireEvent } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ComponentProps } from 'react'
import { useAppStore } from '@/store/index'
import {
  makeFolderWorkspace,
  makeRepo,
  makeWorktree
} from '../../../worktree-jump/worktree-jump-palette-test-fixtures'
import type { AiVaultSession } from '../../../../../../shared/ai-vault/contracts/ai-vault-types'
import { searchHit } from '../../../../../../shared/ai-vault/search/ai-vault-search-test-fixture'
import {
  STRUCTURED_AGENT_SESSION_RESUME_HISTORY_RUNTIME_CAPABILITY,
  STRUCTURED_AGENT_SESSION_RESUME_LINKED_CWD_RUNTIME_CAPABILITY
} from '../../../../../../shared/agent-session/structured-agent-session-surface-capabilities'
import { aiVaultSearchHitToSession } from '../search/ai-vault-search-session'
import type { AiVaultSessionVirtualList } from '../session-list/AiVaultSessionVirtualList'
import type { AiVaultResumeInChatEligibility } from '../session-actions/ai-vault-session-resume-in-chat'

import {
  writeAiVaultViewOptions,
  readAiVaultViewOptions
} from '../scope/ai-vault-view-options-persistence'

type PanelRequest = {
  scopePaths: readonly string[]
  executionHostScope: string
  sessionLimit: number | 'unlimited'
}

const panelRequests = vi.hoisted((): PanelRequest[] => [])
const returned = vi.hoisted((): { sessions: AiVaultSession[] } => ({ sessions: [] }))
const panelRows = vi.hoisted(
  (): { session: AiVaultSession; resume: AiVaultResumeInChatEligibility }[] => []
)

vi.mock('@/runtime/local-runtime-capabilities', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readLocalRuntimeCapabilitiesOrUnknown: () => [
    STRUCTURED_AGENT_SESSION_RESUME_HISTORY_RUNTIME_CAPABILITY,
    STRUCTURED_AGENT_SESSION_RESUME_LINKED_CWD_RUNTIME_CAPABILITY
  ]
}))
vi.mock('@/lib/agent-session/launch/routing/agent-session-launch-plan', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  structuredAgentSessionLaunchFeasible: () => true
}))

vi.mock('./ai-vault-session-refresh', () => ({
  useAiVaultSessionRefresh: (
    scopePaths: PanelRequest['scopePaths'],
    executionHostScope: PanelRequest['executionHostScope'],
    sessionLimit: PanelRequest['sessionLimit']
  ) => {
    panelRequests.push({ scopePaths, executionHostScope, sessionLimit })
    return {
      error: null,
      loading: false,
      refresh: vi.fn(),
      scanResult: null,
      sessions: returned.sessions,
      loadedSessionLimit: null
    }
  }
}))
vi.mock('../session-actions/ai-vault-session-launch-actions', () => ({
  useAiVaultSessionLaunchActions: () => ({ continuationRequest: null })
}))
vi.mock('../session-actions/ai-vault-original-pane-actions', () => ({
  useAiVaultOriginalPaneActions: () => ({})
}))
vi.mock('../session-actions/ai-vault-session-delete-action', () => ({
  useAiVaultSessionDeleteAction: () => vi.fn()
}))
vi.mock('../session-list/AiVaultSessionVirtualList', () => ({
  AiVaultSessionVirtualList: ({
    groups,
    getSessionResumeInChat
  }: Pick<
    ComponentProps<typeof AiVaultSessionVirtualList>,
    'groups' | 'getSessionResumeInChat'
  >) => {
    panelRows.length = 0
    for (const group of groups) {
      for (const session of group.sessions) {
        panelRows.push({ session, resume: getSessionResumeInChat(session) })
      }
    }
    return null
  }
}))

const WORKTREE_ID = 'repo-1::/repo/wt'

beforeEach(() => {
  panelRequests.length = 0
  returned.sessions = []
  panelRows.length = 0
  useAppStore.setState(useAppStore.getInitialState(), true)
  useAppStore.setState({
    activeRepoId: 'repo-1',
    activeWorktreeId: WORKTREE_ID,
    repos: [makeRepo()],
    worktreesByRepo: {
      'repo-1': [
        makeWorktree(WORKTREE_ID, 'wt', { path: '/repo/wt' }),
        makeWorktree('repo-1::/repo/sibling', 'sibling', { path: '/repo/sibling' })
      ]
    }
  })
  writeAiVaultViewOptions({ ...readAiVaultViewOptions(), sessionLimit: 500 })
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { aiVault: { searchSessions: vi.fn() }, ui: { writeClipboardText: vi.fn() } }
  })
})
afterEach(() => {
  cleanup()
  window.localStorage.clear()
})

it.each([false, true])(
  'delivers alias rows to native resume in Workspace and All (bound: %s)',
  async (bound) => {
    const folderId = 'folder:example'
    useAppStore.setState({
      activeWorktreeId: bound ? WORKTREE_ID : folderId,
      folderWorkspaces: [makeFolderWorkspace({ id: 'example', folderPath: '/var/example' })]
    })
    const session = {
      ...aiVaultSearchHitToSession(
        { ...searchHit(), agent: 'claude', cwd: '/private/var/example' },
        'local'
      ),
      cwdAliases: ['/var/example']
    }
    returned.sessions = [session]
    const { default: AiVaultPanel } = await import('../panel/AiVaultPanel')
    render(<AiVaultPanel workspace={bound ? { worktreeId: folderId } : undefined} />)
    expect(panelRequests.at(-1)?.scopePaths).toContain('/var/example')
    expect(panelRows).toEqual([{ session, resume: { available: true, workspaceId: folderId } }])
    expect(panelRows[0].session).toBe(session)
    fireEvent.click(screen.getByRole('radio', { name: /^All$/ }))
    expect(panelRequests.at(-1)?.scopePaths).toContain('/var/example')
    expect(panelRows).toEqual([{ session, resume: { available: true, workspaceId: folderId } }])
    expect(panelRows[0].session.cwd).toBe('/private/var/example')
    expect(panelRows[0].session.sessionId).toBe(session.sessionId)
  }
)
