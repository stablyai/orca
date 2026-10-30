import { afterEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { makeRepo } from '@/components/worktree-jump-palette-test-fixtures'
import { openWorkspaceCreationComposerWithTourHandoff } from './workspace-creation-tour-handoff'
import { requestContextualTourWhenReady } from './request-contextual-tour-when-ready'
import { getContextualTourStepIndex } from '../../../../shared/contextual-tours'

const PARALLEL_STEP_INDEX = getContextualTourStepIndex(
  'workspace-agent-sessions',
  'agent-sessions-parallel'
)

vi.mock('./request-contextual-tour-when-ready', () => ({
  requestContextualTourWhenReady: vi.fn()
}))

function mockStoreState(overrides: () => Partial<AppState>): void {
  const real = useAppStore.getState()
  vi.spyOn(useAppStore, 'getState').mockImplementation(() => ({ ...real, ...overrides() }))
}

describe('openWorkspaceCreationComposerWithTourHandoff', () => {
  afterEach(() => {
    vi.clearAllMocks()
    vi.restoreAllMocks()
  })

  it('opens the workspace composer without a tour handoff outside the agent sessions tour', () => {
    const openModal = vi.fn()
    const detachContextualTourSource = vi.fn()
    mockStoreState(() => ({
      activeContextualTourId: null,
      activeContextualTourStepIndex: 0,
      activeContextualTourSource: null,
      activeModal: 'none',
      contextualToursSeenIds: [],
      repos: [makeRepo()],
      detachContextualTourSource,
      openModal
    }))

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
    let activeModal: AppState['activeModal'] = 'none'
    mockStoreState(() => ({
      activeContextualTourId: 'workspace-agent-sessions',
      activeContextualTourStepIndex: PARALLEL_STEP_INDEX,
      activeContextualTourSource: 'setup_guide_parallel_work',
      activeModal,
      contextualToursSeenIds: [],
      repos: [makeRepo()],
      detachContextualTourSource,
      completeContextualTour,
      openModal
    }))

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
    mockStoreState(() => ({
      activeContextualTourId: 'workspace-agent-sessions',
      activeContextualTourStepIndex: PARALLEL_STEP_INDEX,
      activeContextualTourSource: 'setup_guide_parallel_work',
      activeModal: 'none',
      contextualToursSeenIds: ['workspace-creation'],
      repos: [makeRepo()],
      detachContextualTourSource,
      completeContextualTour,
      openModal
    }))

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

  it('opens the composer without a project so the empty form can guide setup', () => {
    const openModal = vi.fn()
    const detachContextualTourSource = vi.fn()
    mockStoreState(() => ({
      activeContextualTourId: 'workspace-agent-sessions',
      activeContextualTourStepIndex: PARALLEL_STEP_INDEX,
      activeContextualTourSource: 'setup_guide_parallel_work',
      activeModal: 'none',
      contextualToursSeenIds: [],
      repos: [],
      detachContextualTourSource,
      openModal
    }))

    openWorkspaceCreationComposerWithTourHandoff()

    expect(detachContextualTourSource).not.toHaveBeenCalled()
    expect(openModal).toHaveBeenCalledWith('new-workspace-composer', {
      telemetrySource: 'sidebar'
    })
    expect(requestContextualTourWhenReady).not.toHaveBeenCalled()
  })
})
