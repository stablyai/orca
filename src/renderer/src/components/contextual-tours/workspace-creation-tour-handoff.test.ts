import { afterEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { openWorkspaceCreationComposerWithTourHandoff } from './workspace-creation-tour-handoff'
import { requestContextualTourWhenReady } from './request-contextual-tour-when-ready'

vi.mock('./request-contextual-tour-when-ready', () => ({
  requestContextualTourWhenReady: vi.fn()
}))

describe('openWorkspaceCreationComposerWithTourHandoff', () => {
  afterEach(() => {
    vi.clearAllMocks()
    vi.restoreAllMocks()
  })

  it('opens the workspace composer without a tour handoff outside the agent sessions tour', () => {
    const openModal = vi.fn()
    const detachContextualTourSource = vi.fn()
    vi.spyOn(useAppStore, 'getState').mockImplementation(
      () =>
        ({
          activeContextualTourId: null,
          activeContextualTourStepIndex: 0,
          activeContextualTourSource: null,
          activeModal: 'none',
          contextualToursSeenIds: [],
          repos: [{ id: 'repo-1' }],
          detachContextualTourSource,
          openModal
        }) as unknown as ReturnType<typeof useAppStore.getState>
    )

    openWorkspaceCreationComposerWithTourHandoff()

    expect(openModal).toHaveBeenCalledWith('new-workspace-composer', {
      telemetrySource: 'sidebar'
    })
    expect(detachContextualTourSource).not.toHaveBeenCalled()
    expect(requestContextualTourWhenReady).not.toHaveBeenCalled()
  })

  it('hands off from the agent sessions create-worktree step to the workspace-creation tour', () => {
    const openModal = vi.fn()
    const detachContextualTourSource = vi.fn()
    const completeContextualTour = vi.fn()
    let activeModal: ReturnType<typeof useAppStore.getState>['activeModal'] = 'none'
    vi.spyOn(useAppStore, 'getState').mockImplementation(
      () =>
        ({
          activeContextualTourId: 'workspace-agent-sessions',
          activeContextualTourStepIndex: 1,
          activeContextualTourSource: 'setup_guide_parallel_work',
          activeModal,
          contextualToursSeenIds: [],
          repos: [{ id: 'repo-1' }],
          detachContextualTourSource,
          completeContextualTour,
          openModal
        }) as unknown as ReturnType<typeof useAppStore.getState>
    )

    openWorkspaceCreationComposerWithTourHandoff()

    expect(detachContextualTourSource).toHaveBeenCalledWith(
      'workspace-agent-sessions',
      'setup_guide_parallel_work'
    )
    expect(completeContextualTour).toHaveBeenCalledWith('workspace-agent-sessions')
    expect(openModal).toHaveBeenCalledWith('new-workspace-composer', {
      telemetrySource: 'sidebar',
      contextualTourSource: 'workspace_creation_modal'
    })
    expect(requestContextualTourWhenReady).toHaveBeenCalledWith({
      id: 'workspace-creation',
      source: 'workspace_creation_modal',
      wasFeaturePreviouslyInteracted: false,
      waitForActiveTourToClear: true,
      shouldContinue: expect.any(Function)
    })

    const [{ shouldContinue }] = vi.mocked(requestContextualTourWhenReady).mock.calls[0]
    activeModal = 'new-workspace-composer'
    expect(shouldContinue?.()).toBe(true)
    activeModal = 'none'
    expect(shouldContinue?.()).toBe(false)
  })

  it('opens the composer without re-showing workspace creation when that tour was already seen', () => {
    const openModal = vi.fn()
    const detachContextualTourSource = vi.fn()
    const completeContextualTour = vi.fn()
    vi.spyOn(useAppStore, 'getState').mockImplementation(
      () =>
        ({
          activeContextualTourId: 'workspace-agent-sessions',
          activeContextualTourStepIndex: 1,
          activeContextualTourSource: 'setup_guide_parallel_work',
          activeModal: 'none',
          contextualToursSeenIds: ['workspace-creation'],
          repos: [{ id: 'repo-1' }],
          detachContextualTourSource,
          completeContextualTour,
          openModal
        }) as unknown as ReturnType<typeof useAppStore.getState>
    )

    openWorkspaceCreationComposerWithTourHandoff()

    expect(detachContextualTourSource).toHaveBeenCalledWith(
      'workspace-agent-sessions',
      'setup_guide_parallel_work'
    )
    expect(completeContextualTour).toHaveBeenCalledWith('workspace-agent-sessions')
    expect(openModal).toHaveBeenCalledWith('new-workspace-composer', {
      telemetrySource: 'sidebar',
      contextualTourSource: 'workspace_creation_modal'
    })
    expect(requestContextualTourWhenReady).not.toHaveBeenCalled()
  })

  it('does not open the composer when no project is available for workspace creation', () => {
    const openModal = vi.fn()
    const detachContextualTourSource = vi.fn()
    vi.spyOn(useAppStore, 'getState').mockImplementation(
      () =>
        ({
          activeContextualTourId: 'workspace-agent-sessions',
          activeContextualTourStepIndex: 1,
          activeContextualTourSource: 'setup_guide_parallel_work',
          activeModal: 'none',
          contextualToursSeenIds: [],
          repos: [],
          detachContextualTourSource,
          openModal
        }) as unknown as ReturnType<typeof useAppStore.getState>
    )

    openWorkspaceCreationComposerWithTourHandoff()

    expect(detachContextualTourSource).not.toHaveBeenCalled()
    expect(openModal).not.toHaveBeenCalled()
    expect(requestContextualTourWhenReady).not.toHaveBeenCalled()
  })
})
