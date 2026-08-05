// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'

const {
  activateAndRevealWorktreeMock,
  activateTabAndFocusPaneMock,
  focusExistingAiVaultSessionPaneMock,
  launchAiVaultSessionInNewTabMock,
  prepareAiVaultSessionForResumeMock
} = vi.hoisted(() => ({
  activateAndRevealWorktreeMock: vi.fn(() => true),
  activateTabAndFocusPaneMock: vi.fn(),
  focusExistingAiVaultSessionPaneMock: vi.fn(() => false),
  launchAiVaultSessionInNewTabMock: vi.fn(() => ({
    tabId: 'new-tab',
    runtimeLaunch: Promise.resolve({ status: 'ok' })
  })),
  prepareAiVaultSessionForResumeMock: vi.fn((session: unknown) => Promise.resolve(session))
}))

vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealWorktree: activateAndRevealWorktreeMock,
  activateAndRevealFolderWorkspace: vi.fn()
}))
vi.mock('@/lib/activate-tab-and-focus-pane', () => ({
  activateTabAndFocusPane: activateTabAndFocusPaneMock
}))
vi.mock('./ai-vault-resume-focus-existing-pane', () => ({
  focusExistingAiVaultSessionPane: focusExistingAiVaultSessionPaneMock
}))
vi.mock('@/lib/launch-ai-vault-session', () => ({
  launchAiVaultSessionInNewTab: launchAiVaultSessionInNewTabMock
}))
vi.mock('@/lib/ai-vault-session-resume-preparation', () => ({
  prepareAiVaultSessionForResume: prepareAiVaultSessionForResumeMock
}))
vi.mock('@/lib/ai-vault-resume-command', () => ({
  buildAiVaultResumeCopyCommandForWorktree: vi.fn(() => 'claude --resume sess-1'),
  buildAiVaultResumeStartupForWorktree: vi.fn(() => ({ command: 'claude --resume sess-1' }))
}))
vi.mock('@/lib/ai-vault-resume-target', () => ({
  canResumeAiVaultSessionOnTarget: vi.fn(() => true),
  getAiVaultResumeWorkspaceExecutionHostId: vi.fn(() => null),
  getAiVaultResumeWorkspaceTargetStatus: vi.fn(() => 'local')
}))
vi.mock('./ai-vault-session-resume', () => ({
  isKnownAiVaultResumeWorkspaceTarget: vi.fn(() => true)
}))
vi.mock('@/lib/sleeping-agent-pane-ownership', () => ({
  isPassiveCompletedHibernationEvidence: vi.fn(() => false)
}))

import { useAiVaultSessionLaunchActions } from './ai-vault-session-launch-actions'

function makeSession(overrides: Partial<AiVaultSession> = {}): AiVaultSession {
  return {
    agent: 'claude',
    sessionId: 'sess-1',
    filePath: '/home/user/.claude/projects/proj/sess-1.jsonl',
    title: 'session',
    updatedAt: 1,
    ...overrides
  } as AiVaultSession
}

function renderActions(): ReturnType<typeof useAiVaultSessionLaunchActions> {
  const { result } = renderHook(() =>
    useAiVaultSessionLaunchActions({
      activeWorktree: null,
      activeWorktreeId: 'wt-1',
      targetState: {} as never
    })
  )
  return result.current
}

describe('useAiVaultSessionLaunchActions handleResume', () => {
  beforeEach(() => {
    focusExistingAiVaultSessionPaneMock.mockReset()
    launchAiVaultSessionInNewTabMock.mockClear()
    activateAndRevealWorktreeMock.mockClear()
    activateTabAndFocusPaneMock.mockClear()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('does not launch when the pre-flight focused a live pane', () => {
    focusExistingAiVaultSessionPaneMock.mockReturnValue(true)

    renderActions().handleResume(makeSession())

    expect(focusExistingAiVaultSessionPaneMock).toHaveBeenCalledTimes(1)
    expect(launchAiVaultSessionInNewTabMock).not.toHaveBeenCalled()
  })

  it('launches in a new tab when no pane owns the session', async () => {
    focusExistingAiVaultSessionPaneMock.mockReturnValue(false)

    renderActions().handleResume(makeSession())
    await vi.waitFor(() => {
      expect(launchAiVaultSessionInNewTabMock).toHaveBeenCalledTimes(1)
    })
    expect(activateTabAndFocusPaneMock).not.toHaveBeenCalled()
  })
})
