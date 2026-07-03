// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  SETUP_GUIDE_PROJECT_PROMPT,
  WorkspacesAction,
  cancelPendingSetupGuideTourRequest,
  getSetupGuideGitRepo,
  isSetupGuideWorkspaceComposerRequestCurrent,
  promptForSetupGuideProject,
  requestSetupGuideTourWhenReady
} from './FeatureWallSetupWorkflowActions'
import { useAppStore } from '@/store'
import { toast } from 'sonner'
import type { Repo } from '../../../../shared/types'

vi.mock('sonner', () => ({
  toast: {
    message: vi.fn(),
    success: vi.fn(),
    error: vi.fn()
  }
}))

const mountedRoots: Root[] = []

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

describe('setup guide workflow actions', () => {
  afterEach(async () => {
    await act(async () => {
      for (const root of mountedRoots.splice(0)) {
        root.unmount()
      }
    })
    document.body.innerHTML = ''
    cancelPendingSetupGuideTourRequest()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    vi.useRealTimers()
    useAppStore.setState({
      activeModal: 'none',
      modalData: {},
      activeWorktreeId: null,
      worktreesByRepo: {},
      tabsByWorktree: {},
      activeTabId: null,
      activeGroupIdByWorktree: {},
      terminalLayoutsByTabId: {},
      repos: [],
      activeRepoId: null,
      activeContextualTourId: null
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

  it('opens the workspace composer with setup-guide tour context from Multi-task', async () => {
    vi.useFakeTimers()
    const requestContextualTour = vi.fn()
    useAppStore.setState({
      activeModal: 'none',
      modalData: {},
      repos: [makeRepo('repo-1')],
      activeRepoId: 'repo-1',
      activeContextualTourId: null,
      requestContextualTour: requestContextualTour as never
    })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    mountedRoots.push(root)

    await act(async () => {
      root.render(<WorkspacesAction done={false} />)
    })
    const button = container.querySelector('button')
    expect(button?.textContent).toContain('Try it out')

    await act(async () => {
      button?.click()
    })

    expect(useAppStore.getState().activeModal).toBe('new-workspace-composer')
    expect(useAppStore.getState().modalData).toMatchObject({
      initialRepoId: 'repo-1',
      telemetrySource: 'unknown',
      contextualTourSource: 'setup_guide_parallel_work'
    })

    await act(async () => {
      vi.runOnlyPendingTimers()
    })

    expect(requestContextualTour).toHaveBeenCalledWith(
      'workspace-creation',
      'setup_guide_parallel_work',
      false,
      { force: true }
    )
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
