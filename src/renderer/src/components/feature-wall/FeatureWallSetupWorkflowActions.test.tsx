import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  SETUP_GUIDE_PROJECT_PROMPT,
  activateWorktreeTerminalForSetupTour,
  cancelPendingSetupGuideTourRequest,
  getSetupGuideGitRepo,
  isSetupGuideWorkspaceComposerRequestCurrent,
  promptForSetupGuideProject,
  requestSetupGuideTourAfterFrame,
  requestSetupGuideTourWhenReady
} from './FeatureWallSetupWorkflowActions'
import { useAppStore } from '@/store'
import * as worktreeActivation from '@/lib/worktree-activation'
import * as webRuntimeSession from '@/runtime/web-runtime-session'
import { toast } from 'sonner'
import type { Repo } from '../../../../shared/types'

vi.mock('sonner', () => ({
  toast: {
    message: vi.fn(),
    success: vi.fn(),
    error: vi.fn()
  }
}))

vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealWorktree: vi.fn()
}))

vi.mock('@/lib/focus-terminal-tab-surface', () => ({
  focusTerminalTabSurface: vi.fn()
}))

vi.mock('@/runtime/web-runtime-session', () => ({
  isWebRuntimeSessionActive: vi.fn(() => false)
}))

vi.mock('./FeatureWallSetupStepVisuals', () => ({
  SetupTwoAgentsVisual: () => <div />,
  SetupWorkspacesVisual: () => <div />,
  SetupMultipleReposVisual: () => <div />
}))

function makeRepo(id: string, overrides: Partial<Repo> = {}): Repo {
  return {
    id,
    path: `/tmp/${id}`,
    displayName: id,
    badgeColor: '#000000',
    addedAt: 1,
    kind: 'git',
    ...overrides
  }
}

describe('TwoAgentsAction', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    useAppStore.setState({
      activeWorktreeId: null,
      worktreesByRepo: {},
      tabsByWorktree: {},
      activeTabId: null,
      activeGroupIdByWorktree: {},
      terminalLayoutsByTabId: {}
    })
  })

  it('prompts for a project before setup-guide actions that need one', () => {
    const openModal = vi.fn()

    promptForSetupGuideProject(openModal)

    expect(openModal).toHaveBeenCalledWith('add-repo')
    expect(toast.message).toHaveBeenCalledWith(SETUP_GUIDE_PROJECT_PROMPT)
  })

  it('chooses the active git repo for setup-guide workspace creation', () => {
    const active = makeRepo('active')

    expect(getSetupGuideGitRepo([makeRepo('first'), active], 'active')).toBe(active)
  })

  it('falls back to the first git repo when the active project is a folder', () => {
    const gitRepo = makeRepo('git')

    expect(getSetupGuideGitRepo([makeRepo('folder', { kind: 'folder' }), gitRepo], 'folder')).toBe(
      gitRepo
    )
  })

  it('returns no setup-guide repo when only folders exist', () => {
    expect(getSetupGuideGitRepo([makeRepo('folder', { kind: 'folder' })], 'folder')).toBeNull()
  })

  it('creates a terminal tab before requesting the split tour when a worktree has only editor/browser tabs', () => {
    const createTab = vi.fn(() => ({ id: 'terminal-tab-1' }))
    const setActiveTab = vi.fn()
    const setActiveTabType = vi.fn()
    vi.mocked(worktreeActivation.activateAndRevealWorktree).mockReturnValue({ primaryTabId: null })
    useAppStore.setState({
      activeWorktreeId: 'worktree-1',
      worktreesByRepo: {
        'repo-1': [{ id: 'worktree-1', repoId: 'repo-1' }]
      } as never,
      tabsByWorktree: { 'worktree-1': [] },
      activeTabId: 'editor-tab-1',
      activeGroupIdByWorktree: { 'worktree-1': 'group-1' },
      terminalLayoutsByTabId: {},
      closeModal: vi.fn(),
      createTab: createTab as never,
      setActiveTabType: setActiveTabType as never,
      setActiveTab: setActiveTab as never
    })

    const tabId = activateWorktreeTerminalForSetupTour('worktree-1')

    expect(tabId).toBe('terminal-tab-1')
    expect(createTab).toHaveBeenCalledWith('worktree-1', 'group-1')
    expect(setActiveTabType).toHaveBeenCalledWith('terminal')
    expect(setActiveTab).toHaveBeenCalledWith('terminal-tab-1')
  })

  it('does not create a local fallback terminal for paired web runtime sessions', () => {
    const createTab = vi.fn(() => ({ id: 'terminal-tab-1' }))
    const setActiveTab = vi.fn()
    vi.mocked(webRuntimeSession.isWebRuntimeSessionActive).mockReturnValue(true)
    vi.mocked(worktreeActivation.activateAndRevealWorktree).mockReturnValue({ primaryTabId: null })
    useAppStore.setState({
      settings: { activeRuntimeEnvironmentId: 'runtime-1' } as never,
      activeWorktreeId: 'worktree-1',
      worktreesByRepo: {
        'repo-1': [{ id: 'worktree-1', repoId: 'repo-1' }]
      } as never,
      tabsByWorktree: { 'worktree-1': [] },
      activeTabId: 'editor-tab-1',
      activeGroupIdByWorktree: { 'worktree-1': 'group-1' },
      terminalLayoutsByTabId: {},
      createTab: createTab as never,
      setActiveTab: setActiveTab as never
    })

    const tabId = activateWorktreeTerminalForSetupTour('worktree-1')

    expect(tabId).toBeNull()
    expect(createTab).not.toHaveBeenCalled()
    expect(setActiveTab).not.toHaveBeenCalled()
  })

  it('keeps setup-guide tour work alive across the modal transition that unmounts the action', () => {
    const callbacks: FrameRequestCallback[] = []
    const callback = vi.fn()
    vi.stubGlobal('window', {
      requestAnimationFrame: vi.fn((frameCallback: FrameRequestCallback) => {
        callbacks.push(frameCallback)
        return callbacks.length
      }),
      cancelAnimationFrame: vi.fn()
    })

    requestSetupGuideTourAfterFrame(callback)
    callbacks[0]?.(1)

    expect(callback).toHaveBeenCalledTimes(1)

    cancelPendingSetupGuideTourRequest()
  })

  it('gates setup-guide tour retries on the expected destination surface', () => {
    vi.useFakeTimers()
    const requestContextualTour = vi.fn()
    useAppStore.setState({
      activeModal: 'none',
      activeContextualTourId: null,
      requestContextualTour: requestContextualTour as never
    })

    requestSetupGuideTourWhenReady({
      id: 'workspace-creation',
      source: 'setup_guide_parallel_work',
      shouldContinue: () => useAppStore.getState().activeModal === 'new-workspace-composer',
      retryDelayMs: 10,
      maxAttempts: 5
    })

    vi.advanceTimersByTime(50)

    expect(requestContextualTour).not.toHaveBeenCalled()

    cancelPendingSetupGuideTourRequest()
    vi.useRealTimers()
  })

  it('rejects a stale setup-guide composer request after close and reopen', () => {
    useAppStore.setState({
      activeModal: 'new-workspace-composer',
      modalData: { setupGuideTourRequestId: 'new-request' }
    })

    expect(isSetupGuideWorkspaceComposerRequestCurrent('old-request')).toBe(false)
    expect(isSetupGuideWorkspaceComposerRequestCurrent('new-request')).toBe(true)
  })
})
