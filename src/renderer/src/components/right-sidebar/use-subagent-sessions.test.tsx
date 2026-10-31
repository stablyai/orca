// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { aiVaultSearchHitToSession } from './ai-vault-search-session'
import { searchHit } from '../../../../shared/ai-vault-search-test-fixture'
import * as correspondence from '../../../../shared/ai-vault-session-cwd-aliases'
import {
  STRUCTURED_AGENT_SESSION_RESUME_HISTORY_RUNTIME_CAPABILITY,
  STRUCTURED_AGENT_SESSION_RESUME_LINKED_CWD_RUNTIME_CAPABILITY
} from '../../../../shared/protocol-version'
import { makeFolderWorkspace, makeWorktree } from '../worktree-jump-palette-test-fixtures'
import { aiVaultSessionOwnerWorkspaces } from './ai-vault-session-worktree'
import { resolveAiVaultHistoryRowResume } from './ai-vault-session-resume-in-chat-workspace'
import { useSubagentSessions } from './use-subagent-sessions'
import type { AiVaultListResult } from '../../../../shared/ai-vault-types'
import { reuseAiVaultListResult } from './ai-vault-session-identity'

vi.mock('@/runtime/local-runtime-capabilities', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readLocalRuntimeCapabilitiesOrUnknown: () => [
    STRUCTURED_AGENT_SESSION_RESUME_HISTORY_RUNTIME_CAPABILITY,
    STRUCTURED_AGENT_SESSION_RESUME_LINKED_CWD_RUNTIME_CAPABILITY
  ]
}))
vi.mock('@/lib/agent-session-launch-plan', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  structuredAgentSessionLaunchFeasible: () => true
}))

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function parentSession() {
  return aiVaultSearchHitToSession(
    { ...searchHit(), agent: 'omp', cwd: '/private/var/example' },
    'local'
  )
}

it('bounds loaded-child correspondence work at N and 10N without alias-only refetches', async () => {
  const copy = vi.spyOn(correspondence, 'withAiVaultSessionCwdAliases')
  for (const size of [100, 1000]) {
    copy.mockClear()
    const parent = parentSession()
    const children = Array.from({ length: size }, (_, index) => ({
      ...parent,
      sessionId: `child-${index}`,
      filePath: `/child-${index}.jsonl`,
      subagent: { parentSessionId: parent.sessionId, agentType: null, status: null }
    }))
    const list = vi.fn().mockResolvedValue({ sessions: children, issues: [] })
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { aiVault: { listSubagentSessions: list } }
    })
    const { result, rerender, unmount } = renderHook(useSubagentSessions, { initialProps: parent })
    await act(async () => {})
    expect(result.current.status).toBe('loaded')
    expect(result.current.sessions).toBe(children)
    expect(copy).not.toHaveBeenCalled()
    rerender({ ...parent, title: 'No aliases yet' })
    expect(result.current.sessions).toBe(children)
    expect(copy).not.toHaveBeenCalled()
    copy.mockClear()
    const updated = { ...parent, cwdAliases: ['/var/example'] }
    rerender(updated)
    expect(result.current.sessions.every((row) => row.cwdAliases?.[0] === '/var/example')).toBe(
      true
    )
    expect(copy).toHaveBeenCalledTimes(size)
    const projected = result.current.sessions
    copy.mockClear()
    rerender({ ...updated, title: 'Renamed parent' })
    expect(copy).not.toHaveBeenCalled()
    expect(result.current.sessions).toBe(projected)
    let published: AiVaultListResult = { sessions: [updated], issues: [], scannedAt: '' }
    for (const title of ['Transport rename', 'Another metadata update']) {
      const incoming = structuredClone(published)
      incoming.sessions[0].title = title
      incoming.sessions[0].totalTokens += 1
      published = reuseAiVaultListResult(published, incoming)
      const delivered = published.sessions[0]
      expect(delivered).toBe(incoming.sessions[0])
      expect(delivered.cwdAliases).not.toBe(updated.cwdAliases)
      expect(delivered.cwdAliases).toEqual(updated.cwdAliases)
      rerender(delivered)
      expect(copy).not.toHaveBeenCalled()
      expect(result.current.sessions).toBe(projected)
    }
    rerender({ ...updated, cwdAliases: ['/var/relinked'] })
    expect(copy).toHaveBeenCalledTimes(size)
    expect(result.current.sessions.every((row) => row.cwdAliases?.[0] === '/var/relinked')).toBe(
      true
    )
    copy.mockClear()
    rerender(parent)
    expect(copy).not.toHaveBeenCalled()
    expect(result.current.sessions).toBe(children)
    expect(list).toHaveBeenCalledTimes(1)
    for (const changed of [
      { cwd: '/private/var/other' },
      { executionHostId: 'runtime:other' as const },
      { filePath: '//wsl.localhost/Ubuntu/parent.jsonl' },
      { agent: 'claude' as const }
    ]) {
      rerender(updated)
      await act(async () => {})
      expect(result.current.sessions.every((row) => row.cwdAliases?.[0] === '/var/example')).toBe(
        true
      )
      rerender({ ...updated, ...changed })
      await act(async () => {})
      expect(result.current.sessions.every((row, index) => row === children[index])).toBe(true)
    }
    unmount()
  }
})

it('derives loaded child and grandchild correspondence from current same-cwd evidence without refetching', async () => {
  const parent = parentSession()
  const child = {
    ...parent,
    sessionId: 'child',
    filePath: '/child.jsonl',
    subagent: { parentSessionId: parent.sessionId, agentType: null, status: null }
  }
  const list = vi.fn().mockResolvedValue({ sessions: [child], issues: [] })
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { aiVault: { listSubagentSessions: list } }
  })
  useAppStore.setState(useAppStore.getInitialState(), true)
  useAppStore.setState({
    folderWorkspaces: [makeFolderWorkspace({ id: 'example', folderPath: '/var/example' })],
    worktreesByRepo: { 'repo-1': [makeWorktree('elsewhere', 'elsewhere', { path: '/elsewhere' })] }
  })
  const state = useAppStore.getState()
  const resume = (session: typeof parent) =>
    resolveAiVaultHistoryRowResume({
      session,
      worktreeInfo: null,
      worktrees: aiVaultSessionOwnerWorkspaces(
        state.worktreesByRepo['repo-1'],
        state.folderWorkspaces
      ),
      repos: state.repos,
      activeWorktreeId: 'elsewhere',
      targetState: state,
      settings: state.settings
    })
  const { result, rerender, unmount } = renderHook(useSubagentSessions, { initialProps: parent })
  await act(async () => {})
  expect(resume(result.current.sessions[0]).resumeInChat.available).toBe(false)
  rerender({ ...parent, cwdAliases: ['/var/example'] })
  const inherited = result.current.sessions[0]
  expect(resume(inherited)).toEqual({
    resumeState: { blocked: false, worktreeId: 'folder:example', usesSessionWorktree: true },
    resumeInChat: { available: true, workspaceId: 'folder:example' }
  })
  expect(inherited.cwd).toBe(parent.cwd)
  expect(inherited.sessionId).toBe(child.sessionId)
  expect(list).toHaveBeenCalledTimes(1)
  unmount()

  const grandchild = {
    ...child,
    sessionId: 'grandchild',
    subagent: { ...child.subagent, parentSessionId: child.sessionId }
  }
  const different = { ...grandchild, sessionId: 'different', cwd: '/private/var/other' }
  const foreign = { ...grandchild, sessionId: 'foreign', executionHostId: 'runtime:other' as const }
  const wsl = {
    ...grandchild,
    sessionId: 'wsl',
    filePath: '//wsl.localhost/Ubuntu/grandchild.jsonl'
  }
  list.mockResolvedValue({ sessions: [grandchild, different, foreign, wsl], issues: [] })
  const nested = renderHook(useSubagentSessions, { initialProps: inherited })
  await act(async () => {})
  expect(nested.result.current.sessions.map((session) => session.cwdAliases)).toEqual([
    ['/var/example'],
    undefined,
    undefined,
    undefined
  ])
  expect(
    nested.result.current.sessions.map((session) => resume(session).resumeInChat.available)
  ).toEqual([true, false, false, false])
  nested.unmount()
})
