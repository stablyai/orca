import { describe, expect, it, vi } from 'vitest'
import { performContextualTourStepAction } from './contextual-tour-step-actions'

describe('performContextualTourStepAction', () => {
  it('opens Tasks after detaching the terminal-owned tour source', () => {
    const finishTour = vi.fn()
    const advanceContextualTour = vi.fn()
    const detachContextualTourSource = vi.fn()
    const openTaskPage = vi.fn()

    performContextualTourStepAction({
      action: { kind: 'open-tasks', label: 'Show tasks' },
      activeTabId: 'tab-1',
      isLastStep: false,
      finishTour,
      advanceContextualTour,
      detachContextualTourSource,
      setSidebarOpen: vi.fn(),
      openTaskPage,
      openModal: vi.fn(),
      canCreateWorkspace: true,
      openWorkspaceComposer: vi.fn(),
      dispatchTerminalPaneSplit: vi.fn(),
      schedule: vi.fn()
    })

    expect(detachContextualTourSource).toHaveBeenCalledTimes(1)
    expect(openTaskPage).toHaveBeenCalledTimes(1)
    expect(advanceContextualTour).toHaveBeenCalledTimes(1)
    expect(finishTour).not.toHaveBeenCalled()
  })

  it('dispatches the terminal-pane split action against the active tab', () => {
    const dispatchTerminalPaneSplit = vi.fn()

    performContextualTourStepAction({
      action: { kind: 'split-terminal-pane', label: 'Split terminal' },
      activeTabId: 'tab-1',
      isLastStep: false,
      finishTour: vi.fn(),
      advanceContextualTour: vi.fn(),
      detachContextualTourSource: vi.fn(),
      setSidebarOpen: vi.fn(),
      openTaskPage: vi.fn(),
      openModal: vi.fn(),
      canCreateWorkspace: true,
      openWorkspaceComposer: vi.fn(),
      dispatchTerminalPaneSplit,
      schedule: vi.fn()
    })

    expect(dispatchTerminalPaneSplit).toHaveBeenCalledWith({
      tabId: 'tab-1',
      direction: 'vertical'
    })
  })

  it('opens the workspace composer after detaching, without advancing the tour itself', () => {
    const detachContextualTourSource = vi.fn()
    const openWorkspaceComposer = vi.fn()
    const advanceContextualTour = vi.fn()
    const finishTour = vi.fn()

    performContextualTourStepAction({
      action: { kind: 'create-worktree', label: 'Create worktree' },
      activeTabId: 'tab-1',
      isLastStep: true,
      finishTour,
      advanceContextualTour,
      detachContextualTourSource,
      setSidebarOpen: vi.fn(),
      openTaskPage: vi.fn(),
      openModal: vi.fn(),
      canCreateWorkspace: true,
      openWorkspaceComposer,
      dispatchTerminalPaneSplit: vi.fn(),
      schedule: vi.fn()
    })

    // Opening the composer cancels this tour and hands off, so we neither
    // advance nor finish it here.
    expect(detachContextualTourSource).toHaveBeenCalledTimes(1)
    expect(openWorkspaceComposer).toHaveBeenCalledTimes(1)
    expect(advanceContextualTour).not.toHaveBeenCalled()
    expect(finishTour).not.toHaveBeenCalled()
  })

  it('does not open the workspace composer when workspace creation is unavailable', () => {
    const detachContextualTourSource = vi.fn()
    const openWorkspaceComposer = vi.fn()

    performContextualTourStepAction({
      action: { kind: 'create-worktree', label: 'Create worktree' },
      activeTabId: 'tab-1',
      isLastStep: true,
      finishTour: vi.fn(),
      advanceContextualTour: vi.fn(),
      detachContextualTourSource,
      setSidebarOpen: vi.fn(),
      openTaskPage: vi.fn(),
      openModal: vi.fn(),
      canCreateWorkspace: false,
      openWorkspaceComposer,
      dispatchTerminalPaneSplit: vi.fn(),
      schedule: vi.fn()
    })

    expect(detachContextualTourSource).not.toHaveBeenCalled()
    expect(openWorkspaceComposer).not.toHaveBeenCalled()
  })
})
