import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PersistedUIState } from '../../../../shared/persisted-ui-state-types'
import type { ContextualTourId } from '../../../../shared/contextual-tours'
import { createUIStore, makePersistedUI } from './ui-slice-test-harness'

const mocks = vi.hoisted(() => ({
  sendNotesToActiveAgentSession: vi.fn(),
  track: vi.fn(),
  toastMessage: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn()
}))

vi.mock('@/lib/active-agent-note-send', () => ({
  activeAgentNotesSendFailureMessage: (
    status: string,
    options: { explicitTarget?: boolean } = {}
  ) => (options.explicitTarget ? `selected:${status}` : status),
  sendNotesToActiveAgentSession: mocks.sendNotesToActiveAgentSession
}))

vi.mock('@/lib/telemetry', () => ({
  track: mocks.track
}))

vi.mock('sonner', () => ({
  toast: {
    message: mocks.toastMessage,
    success: mocks.toastSuccess,
    error: mocks.toastError
  }
}))

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

beforeEach(() => {
  mocks.sendNotesToActiveAgentSession.mockReset()
  mocks.sendNotesToActiveAgentSession.mockResolvedValue({ status: 'sent' })
  mocks.track.mockReset()
  mocks.toastMessage.mockReset()
  mocks.toastSuccess.mockReset()
  mocks.toastError.mockReset()
})

function stubContextualTourTargets(selectors: readonly string[]): void {
  const selectorSet = new Set(selectors)
  vi.stubGlobal('document', {
    querySelector: vi.fn((selector: string) =>
      selectorSet.has(selector)
        ? {
            getBoundingClientRect: () => ({
              left: 10,
              top: 10,
              right: 110,
              bottom: 50,
              width: 100,
              height: 40
            })
          }
        : null
    )
  })
}

describe('createUISlice contextual tours', () => {
  function makeAutoTourEligibleUI(overrides: Partial<PersistedUIState> = {}): PersistedUIState {
    return makePersistedUI({
      contextualToursAutoEligible: true,
      ...overrides
    })
  }

  it('normalizes persisted contextual tour ids during hydration', () => {
    const store = createUIStore()

    store.getState().hydratePersistedUI(
      makePersistedUI({
        contextualToursSeenIds: ['tasks', 'unknown', 'tasks', 'browser'] as never
      })
    )

    expect(store.getState().contextualToursSeenIds).toEqual(['tasks', 'browser'])
  })

  it('normalizes persisted contextual tour auto eligibility during hydration', () => {
    const store = createUIStore()

    store.getState().hydratePersistedUI(makePersistedUI())
    expect(store.getState().contextualToursAutoEligible).toBeNull()

    store.getState().hydratePersistedUI(makePersistedUI({ contextualToursAutoEligible: false }))
    expect(store.getState().contextualToursAutoEligible).toBe(false)

    store
      .getState()
      .hydratePersistedUI(makePersistedUI({ contextualToursAutoEligible: 'yes' as never }))
    expect(store.getState().contextualToursAutoEligible).toBeNull()
  })

  it('persists contextual tour auto eligibility once classified', () => {
    const setMock = vi.fn(() => Promise.resolve())
    vi.stubGlobal('window', {
      api: {
        ui: {
          set: setMock
        }
      }
    })
    const store = createUIStore()

    store.getState().setContextualToursAutoEligible(false)
    store.getState().setContextualToursAutoEligible(false)

    expect(store.getState().contextualToursAutoEligible).toBe(false)
    expect(setMock).toHaveBeenCalledTimes(1)
    expect(setMock).toHaveBeenCalledWith({ contextualToursAutoEligible: false })
  })

  it('marks contextual tours seen and persists them once', () => {
    const setMock = vi.fn(() => Promise.resolve())
    vi.stubGlobal('window', {
      api: {
        ui: {
          set: setMock
        }
      }
    })
    const store = createUIStore()

    store.getState().markContextualToursSeen(['tasks'])
    store.getState().markContextualToursSeen(['tasks'])

    expect(store.getState().contextualToursSeenIds).toEqual(['tasks'])
    expect(setMock).toHaveBeenCalledTimes(1)
    expect(setMock).toHaveBeenCalledWith({ contextualToursSeenIds: ['tasks'] })
  })

  it('starts a tour only after persisted UI and required first target are ready', () => {
    const store = createUIStore()
    const tasksFirstSelector = '[data-contextual-tour-target="tasks-source-filters"]'
    stubContextualTourTargets([tasksFirstSelector])

    store.getState().requestContextualTour('tasks', 'tasks_open')
    expect(store.getState().activeContextualTourId).toBeNull()

    store.getState().hydratePersistedUI(makeAutoTourEligibleUI())
    store.getState().requestContextualTour('tasks', 'tasks_open')

    expect(store.getState().activeContextualTourId).toBe('tasks')
    expect(store.getState().activeContextualTourStepIndex).toBe(0)
    expect(store.getState().activeContextualTourSource).toBe('tasks_open')
    expect(store.getState().contextualTourShownThisSession).toBe(true)
    expect(store.getState().contextualToursSeenIds).toEqual([])
  })

  it('stores whether the feature was interacted with before the tour request', () => {
    const store = createUIStore()
    const tasksFirstSelector = '[data-contextual-tour-target="tasks-source-filters"]'
    stubContextualTourTargets([tasksFirstSelector])
    store.getState().hydratePersistedUI(makeAutoTourEligibleUI())

    store.getState().recordFeatureInteraction('tasks')
    store.getState().requestContextualTour('tasks', 'tasks_open')

    expect(store.getState().activeContextualTourWasFeaturePreviouslyInteracted).toBe(true)
  })

  it('lets the caller preserve the pre-enable interaction snapshot for telemetry', () => {
    const store = createUIStore()
    const tasksFirstSelector = '[data-contextual-tour-target="tasks-source-filters"]'
    stubContextualTourTargets([tasksFirstSelector])
    store.getState().hydratePersistedUI(makeAutoTourEligibleUI())

    store.getState().recordFeatureInteraction('tasks')
    store.getState().requestContextualTour('tasks', 'tasks_open', false)

    expect(store.getState().activeContextualTourWasFeaturePreviouslyInteracted).toBe(false)
  })

  it('does not bias first-visit contextual tour telemetry from navigation actions', () => {
    stubContextualTourTargets([
      '[data-contextual-tour-target="tasks-source-filters"]',
      '[data-contextual-tour-target="automations-create"]',
      '[data-contextual-tour-target="workspace-creation-project"]'
    ])

    const tasksStore = createUIStore()
    tasksStore.getState().hydratePersistedUI(makeAutoTourEligibleUI())
    tasksStore.getState().openTaskPage()
    tasksStore.getState().requestContextualTour('tasks', 'tasks_open')
    expect(tasksStore.getState().activeContextualTourWasFeaturePreviouslyInteracted).toBe(false)

    const automationsStore = createUIStore()
    automationsStore.getState().hydratePersistedUI(makeAutoTourEligibleUI())
    automationsStore.getState().openAutomationsPage()
    automationsStore.getState().requestContextualTour('automations', 'automations_open')
    expect(automationsStore.getState().activeContextualTourWasFeaturePreviouslyInteracted).toBe(
      false
    )

    const composerStore = createUIStore()
    composerStore.getState().hydratePersistedUI(makeAutoTourEligibleUI())
    composerStore.getState().openModal('new-workspace-composer')
    composerStore.getState().requestContextualTour('workspace-creation', 'workspace_creation_modal')
    expect(composerStore.getState().activeContextualTourWasFeaturePreviouslyInteracted).toBe(false)
  })

  it('does not mark seen when the required first target is absent', () => {
    const store = createUIStore()
    stubContextualTourTargets([])
    store.getState().hydratePersistedUI(makeAutoTourEligibleUI())

    store.getState().requestContextualTour('tasks', 'tasks_open')

    expect(store.getState().activeContextualTourId).toBeNull()
    expect(store.getState().contextualToursSeenIds).toEqual([])
    expect(store.getState().contextualTourShownThisSession).toBe(false)
  })

  it('does not start while a root confirmation surface is visible', () => {
    const store = createUIStore()
    stubContextualTourTargets(['[data-contextual-tour-target="tasks-source-filters"]'])
    store.getState().hydratePersistedUI(makeAutoTourEligibleUI())

    store.getState().setContextualToursBlockingSurfaceVisible(true)
    store.getState().requestContextualTour('tasks', 'tasks_open')

    expect(store.getState().activeContextualTourId).toBeNull()
    expect(store.getState().contextualTourShownThisSession).toBe(false)
  })

  it('does not auto-start tours for profiles that are not eligible', () => {
    const store = createUIStore()
    stubContextualTourTargets(['[data-contextual-tour-target="tasks-source-filters"]'])
    store.getState().hydratePersistedUI(makePersistedUI({ contextualToursAutoEligible: false }))

    store.getState().requestContextualTour('tasks', 'tasks_open')

    expect(store.getState().activeContextualTourId).toBeNull()
    expect(store.getState().contextualTourShownThisSession).toBe(false)
  })

  it('force-starts a tour from an explicit user action even after auto tours are unavailable', () => {
    const store = createUIStore()
    stubContextualTourTargets([
      '[data-contextual-tour-target="terminal-pane-split-target"], [data-contextual-tour-target="workspace-agent-terminal-tip"]'
    ])
    store.getState().hydratePersistedUI(
      makePersistedUI({
        contextualToursAutoEligible: false,
        contextualToursSeenIds: ['workspace-agent-sessions']
      })
    )

    store
      .getState()
      .requestContextualTour('workspace-agent-sessions', 'setup_guide_parallel_work', false, {
        force: true
      })

    expect(store.getState().activeContextualTourId).toBe('workspace-agent-sessions')
    expect(store.getState().activeContextualTourSource).toBe('setup_guide_parallel_work')
    expect(store.getState().activeContextualTourWasFeaturePreviouslyInteracted).toBe(false)
  })

  it('preserves the bounded setup-guide parallel-work source on forced tour requests', () => {
    const store = createUIStore()
    stubContextualTourTargets([
      '[data-contextual-tour-target="terminal-pane-split-target"], [data-contextual-tour-target="workspace-agent-terminal-tip"]'
    ])
    store.getState().hydratePersistedUI(
      makePersistedUI({
        contextualToursAutoEligible: false,
        contextualToursSeenIds: ['workspace-agent-sessions']
      })
    )

    store
      .getState()
      .requestContextualTour('workspace-agent-sessions', 'setup_guide_parallel_work', false, {
        force: true
      })

    expect(store.getState().activeContextualTourId).toBe('workspace-agent-sessions')
    expect(store.getState().activeContextualTourSource).toBe('setup_guide_parallel_work')
  })

  it('allows only workspace creation over its workspace composer modal', () => {
    const store = createUIStore()
    stubContextualTourTargets([
      '[data-contextual-tour-target="tasks-source-filters"]',
      '[data-contextual-tour-target="workspace-creation-project"]'
    ])
    store.getState().hydratePersistedUI(makeAutoTourEligibleUI())

    store.getState().openModal('new-workspace-composer')
    store.getState().requestContextualTour('tasks', 'tasks_open')
    expect(store.getState().activeContextualTourId).toBeNull()

    store.getState().requestContextualTour('workspace-creation', 'workspace_creation_modal')
    expect(store.getState().activeContextualTourId).toBe('workspace-creation')
  })

  it('advances across visible steps and leaves completion to the overlay', () => {
    const store = createUIStore()
    const visibleSelectors = [
      '[data-contextual-tour-target="browser-grab-control"]',
      '[data-contextual-tour-target="browser-annotation-control"]',
      '[data-contextual-tour-target="browser-import-cookies-control"]'
    ]
    stubContextualTourTargets(visibleSelectors)
    store.getState().hydratePersistedUI(makeAutoTourEligibleUI())
    store.getState().requestContextualTour('browser', 'browser_visible')

    store.getState().advanceContextualTour()
    expect(store.getState().activeContextualTourStepIndex).toBe(1)

    store.getState().advanceContextualTour()
    expect(store.getState().activeContextualTourId).toBe('browser')
    expect(store.getState().activeContextualTourStepIndex).toBe(2)
  })

  it('advances the browser tour to the cookie step before Import Cookies is measurable', () => {
    const store = createUIStore()
    const visibleSelectors = [
      '[data-contextual-tour-target="browser-grab-control"]',
      '[data-contextual-tour-target="browser-annotation-control"]'
    ]
    stubContextualTourTargets(visibleSelectors)
    store.getState().hydratePersistedUI(makeAutoTourEligibleUI())
    store.getState().requestContextualTour('browser', 'browser_visible')

    store.getState().advanceContextualTour()
    expect(store.getState().activeContextualTourStepIndex).toBe(1)

    store.getState().advanceContextualTour()
    expect(store.getState().activeContextualTourStepIndex).toBe(2)
  })

  it('advances the active split step when the split command interaction is recorded', () => {
    const setMock = vi.fn(() => Promise.resolve())
    vi.stubGlobal('window', {
      api: {
        ui: {
          set: setMock
        }
      }
    })
    const store = createUIStore()
    stubContextualTourTargets([
      '[data-contextual-tour-target="terminal-pane-split-target"], [data-contextual-tour-target="workspace-agent-terminal-tip"]',
      '[data-contextual-tour-target="workspace-create-control"]'
    ])
    store.getState().hydratePersistedUI(makeAutoTourEligibleUI())
    setMock.mockClear()
    store
      .getState()
      .requestContextualTour('workspace-agent-sessions', 'setup_guide_parallel_work', false, {
        force: true
      })

    store.getState().recordFeatureInteraction('terminal-pane-split')

    expect(store.getState().activeContextualTourId).toBe('workspace-agent-sessions')
    expect(store.getState().activeContextualTourStepIndex).toBe(1)
    expect(store.getState().featureInteractions['terminal-pane-split']).toMatchObject({
      interactionCount: 1
    })
  })

  it('opens the sidebar and advances the split step when the create-worktree target is hidden', () => {
    const setMock = vi.fn(() => Promise.resolve())
    vi.stubGlobal('window', {
      api: {
        ui: {
          set: setMock
        }
      }
    })
    const store = createUIStore()
    stubContextualTourTargets([
      '[data-contextual-tour-target="terminal-pane-split-target"], [data-contextual-tour-target="workspace-agent-terminal-tip"]'
    ])
    store.setState({ sidebarOpen: false })
    store.getState().hydratePersistedUI(makeAutoTourEligibleUI())
    store
      .getState()
      .requestContextualTour('workspace-agent-sessions', 'setup_guide_parallel_work', false, {
        force: true
      })

    store.getState().recordFeatureInteraction('terminal-pane-split')

    expect(store.getState().sidebarOpen).toBe(true)
    expect(store.getState().activeContextualTourId).toBe('workspace-agent-sessions')
    expect(store.getState().activeContextualTourStepIndex).toBe(1)
    expect(store.getState().contextualToursSeenIds).toEqual([])
    expect(store.getState().lastCompletedContextualTourId).toBeNull()
  })

  it('marks the active contextual tour suppressed when its owning source disables', () => {
    const store = createUIStore()
    store.setState({
      activeContextualTourId: 'browser',
      activeContextualTourStepIndex: 0,
      activeContextualTourSource: 'browser_visible',
      activeContextualTourWasFeaturePreviouslyInteracted: false,
      contextualTourShownThisSession: true
    })

    store.getState().suppressContextualTour('tasks', 'tasks_open')
    expect(store.getState().activeContextualTourSuppressed).toBe(false)

    store.getState().suppressContextualTour('browser', 'browser_visible')
    expect(store.getState().activeContextualTourSuppressed).toBe(true)
  })

  it('keeps an intentionally detached contextual tour active when its owning source disables', () => {
    const store = createUIStore()
    store.setState({
      activeContextualTourId: 'workspace-agent-sessions',
      activeContextualTourStepIndex: 3,
      activeContextualTourSource: 'workspace_agent_sessions_visible',
      activeContextualTourWasFeaturePreviouslyInteracted: false,
      contextualTourShownThisSession: true
    })

    store
      .getState()
      .detachContextualTourSource('workspace-agent-sessions', 'workspace_agent_sessions_visible')
    store
      .getState()
      .suppressContextualTour('workspace-agent-sessions', 'workspace_agent_sessions_visible')

    expect(store.getState().activeContextualTourSourceDetached).toBe(true)
    expect(store.getState().activeContextualTourSuppressed).toBe(false)
    expect(store.getState().activeContextualTourId).toBe('workspace-agent-sessions')
  })

  it('cancels a not-yet-rendered tour without persistence churn', () => {
    const setMock = vi.fn(() => Promise.resolve())
    vi.stubGlobal('window', {
      api: {
        ui: {
          set: setMock
        }
      }
    })
    const store = createUIStore()
    store.setState({
      activeContextualTourId: 'tasks',
      activeContextualTourStepIndex: 0,
      activeContextualTourSource: 'tasks_open',
      contextualTourShownThisSession: true
    })

    store.getState().cancelContextualTour('tasks')

    expect(store.getState().activeContextualTourId).toBeNull()
    expect(store.getState().contextualTourShownThisSession).toBe(false)
    expect(store.getState().lastCompletedContextualTourId).toBeNull()
    expect(store.getState().contextualToursSeenIds).toEqual([])
    expect(setMock).not.toHaveBeenCalled()
  })

  it('preserves the session guard when canceling an already-rendered tour', () => {
    const setMock = vi.fn(() => Promise.resolve())
    vi.stubGlobal('window', {
      api: {
        ui: {
          set: setMock
        }
      }
    })
    const store = createUIStore()
    store.setState({
      activeContextualTourId: 'tasks',
      activeContextualTourStepIndex: 0,
      activeContextualTourSource: 'tasks_open',
      contextualTourShownThisSession: true,
      contextualToursSeenIds: ['tasks']
    })

    store.getState().cancelContextualTour('tasks')

    expect(store.getState().activeContextualTourId).toBeNull()
    expect(store.getState().contextualTourShownThisSession).toBe(true)
    expect(store.getState().contextualToursSeenIds).toEqual<ContextualTourId[]>(['tasks'])
    expect(setMock).not.toHaveBeenCalled()
  })

  it('dismisses active tours as seen', () => {
    const setMock = vi.fn(() => Promise.resolve())
    vi.stubGlobal('window', {
      api: {
        ui: {
          set: setMock
        }
      }
    })
    const store = createUIStore()
    store.setState({
      activeContextualTourId: 'automations',
      activeContextualTourStepIndex: 0,
      activeContextualTourSource: 'automations_open',
      contextualTourShownThisSession: true
    })

    store.getState().dismissContextualTour('automations')

    expect(store.getState().activeContextualTourId).toBeNull()
    expect(store.getState().contextualToursSeenIds).toEqual<ContextualTourId[]>(['automations'])
    expect(store.getState().lastCompletedContextualTourId).toBeNull()
    expect(setMock).toHaveBeenCalledWith({ contextualToursSeenIds: ['automations'] })
  })

  it('ignores stale dismissals for a different active tour', () => {
    const setMock = vi.fn(() => Promise.resolve())
    vi.stubGlobal('window', {
      api: {
        ui: {
          set: setMock
        }
      }
    })
    const store = createUIStore()
    store.setState({
      activeContextualTourId: 'tasks',
      activeContextualTourStepIndex: 0,
      activeContextualTourSource: 'tasks_open',
      contextualTourShownThisSession: true
    })

    store.getState().dismissContextualTour('browser')

    expect(store.getState().activeContextualTourId).toBe('tasks')
    expect(store.getState().contextualToursSeenIds).toEqual([])
    expect(setMock).not.toHaveBeenCalled()
  })
})
