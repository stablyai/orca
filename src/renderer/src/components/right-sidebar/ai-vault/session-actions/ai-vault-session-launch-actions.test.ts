// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import type { AiVaultSession } from '../../../../../../shared/ai-vault/contracts/ai-vault-types'
import { makeWorktree } from '../../../worktree-jump/worktree-jump-palette-test-fixtures'

const mocks = vi.hoisted(() => ({
  activateStructuredSession: vi.fn(),
  resumeInNewChat: vi.fn(),
  launchAndReveal: vi.fn(),
  getState: vi.fn()
}))

vi.mock('@/store/index', () => ({
  useAppStore: {
    getState: () => mocks.getState()
  }
}))

vi.mock('@/lib/agent-session/open/activate-ai-vault-structured-session', () => ({
  activateAiVaultStructuredSession: mocks.activateStructuredSession
}))

vi.mock('./ai-vault-session-resume-in-chat-launch', () => ({
  resumeAiVaultSessionInNewChat: mocks.resumeInNewChat
}))

vi.mock('@/lib/agent-session/resume/history/launch-ai-vault-session-and-reveal', () => ({
  launchAiVaultSessionAndReveal: mocks.launchAndReveal
}))

vi.mock('@/lib/agent-session/resume/history/ai-vault-session-resume-preparation', () => ({
  prepareAiVaultSessionForResume: vi.fn(async (session) => session),
  prepareAiVaultSessionForTerminalResume: vi.fn(async (session) => session),
  prepareAiVaultSessionForFork: vi.fn(async (session) => ({ session, copied: false })),
  dropDeletedRemoteResumeCwd: vi.fn(async (session) => session)
}))

vi.mock('@/lib/agent-session/resume/history/ai-vault-resume-command', () => ({
  buildAiVaultResumeCopyCommandForWorktree: vi.fn(() => 'opencode resume'),
  buildAiVaultResumeStartupForWorktree: vi.fn(async () => ({ command: 'opencode resume' }))
}))

vi.mock('./ai-vault-session-launch-feedback', () => ({
  resolveAiVaultSessionLaunchTargetOrNotify: vi.fn(() => ({
    status: 'ready',
    worktreeId: 'worktree-1'
  })),
  notifyAiVaultSessionPreparationFailure: vi.fn(),
  notifyAiVaultSessionNoContinuationContext: vi.fn()
}))

import { useAiVaultSessionLaunchActions } from './ai-vault-session-launch-actions'

function makeSession(overrides: Partial<AiVaultSession> = {}): AiVaultSession {
  return {
    id: 'opencode-session-1',
    agent: 'opencode2',
    cwd: '/workspaces/test',
    filePath: '/tmp/opencode/session-1.json',
    executionHostId: 'local',
    title: 'Test Session',
    messageCount: 5,
    previewMessages: [],
    ...overrides
  } as unknown as AiVaultSession
}

const mockWorktree = makeWorktree('worktree-1', 'test', { path: '/workspaces/test' })

describe('useAiVaultSessionLaunchActions session restoration routing', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getState.mockReturnValue({
      settings: {
        agentDefaultSurface: 'chat',
        nativeChatProviders: {}
      }
    })
  })

  it('routes to native chat when configured session mode is chat for opencode2', () => {
    const { result } = renderHook(() =>
      useAiVaultSessionLaunchActions({
        activeWorktree: mockWorktree,
        activeWorktreeId: 'worktree-1',
        targetState: { folderWorkspaces: [], projectGroups: [], repos: [], worktreesByRepo: {} }
      })
    )

    const session = makeSession({ agent: 'opencode2' })
    result.current.handleResume(session, 'worktree-1')

    expect(mocks.resumeInNewChat).toHaveBeenCalledWith(
      session,
      'opencode2',
      'worktree-1',
      expect.any(String)
    )
    expect(mocks.launchAndReveal).not.toHaveBeenCalled()
  })

  it('routes to terminal when configured session mode is terminal', async () => {
    mocks.getState.mockReturnValue({
      settings: {
        agentDefaultSurface: 'terminal',
        nativeChatProviders: {}
      }
    })

    const { result } = renderHook(() =>
      useAiVaultSessionLaunchActions({
        activeWorktree: mockWorktree,
        activeWorktreeId: 'worktree-1',
        targetState: { folderWorkspaces: [], projectGroups: [], repos: [], worktreesByRepo: {} }
      })
    )

    const session = makeSession({ agent: 'opencode2' })
    result.current.handleResume(session, 'worktree-1')

    expect(mocks.resumeInNewChat).not.toHaveBeenCalled()
    await waitFor(() => {
      expect(mocks.launchAndReveal).toHaveBeenCalled()
    })
  })

  it('honors per-agent override for chat mode when global surface is terminal', () => {
    mocks.getState.mockReturnValue({
      settings: {
        agentDefaultSurface: 'terminal',
        nativeChatProviders: { opencode2: true }
      }
    })

    const { result } = renderHook(() =>
      useAiVaultSessionLaunchActions({
        activeWorktree: mockWorktree,
        activeWorktreeId: 'worktree-1',
        targetState: { folderWorkspaces: [], projectGroups: [], repos: [], worktreesByRepo: {} }
      })
    )

    const session = makeSession({ agent: 'opencode2' })
    result.current.handleResume(session, 'worktree-1')

    expect(mocks.resumeInNewChat).toHaveBeenCalledWith(
      session,
      'opencode2',
      'worktree-1',
      expect.any(String)
    )
  })

  it('activates existing structured session directly', () => {
    const { result } = renderHook(() =>
      useAiVaultSessionLaunchActions({
        activeWorktree: mockWorktree,
        activeWorktreeId: 'worktree-1',
        targetState: { folderWorkspaces: [], projectGroups: [], repos: [], worktreesByRepo: {} }
      })
    )

    const structuredSession = {
      connectionId: 'conn-1',
      tabId: 'tab-1'
    }
    const session = makeSession({
      agent: 'opencode2',
      structuredSession: structuredSession as unknown as AiVaultSession['structuredSession']
    })
    result.current.handleResume(session, 'worktree-1')

    expect(mocks.activateStructuredSession).toHaveBeenCalledWith(session)
    expect(mocks.resumeInNewChat).not.toHaveBeenCalled()
    expect(mocks.launchAndReveal).not.toHaveBeenCalled()
  })

  it('routes to terminal for SSH-recorded session even when chat mode is enabled', async () => {
    const { result } = renderHook(() =>
      useAiVaultSessionLaunchActions({
        activeWorktree: mockWorktree,
        activeWorktreeId: 'worktree-1',
        targetState: { folderWorkspaces: [], projectGroups: [], repos: [], worktreesByRepo: {} }
      })
    )

    const session = makeSession({
      agent: 'opencode2',
      executionHostId: 'ssh:remote-server'
    })
    result.current.handleResume(session, 'worktree-1')

    expect(mocks.resumeInNewChat).not.toHaveBeenCalled()
    await waitFor(() => {
      expect(mocks.launchAndReveal).toHaveBeenCalled()
    })
  })
})
