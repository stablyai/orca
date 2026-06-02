import { describe, expect, it } from 'vitest'
import {
  CONTEXTUAL_TOURS,
  normalizeContextualTourIds,
  type ContextualTour,
  type ContextualTourId
} from './contextual-tours'

describe('contextual tour definitions', () => {
  it('defines the required tours with concise visible steps', () => {
    const expectedIds: ContextualTourId[] = [
      'workspace-board',
      'workspace-agent-sessions',
      'browser',
      'tasks',
      'automations',
      'workspace-creation'
    ]

    expect(CONTEXTUAL_TOURS.map((tour) => tour.id)).toEqual(expectedIds)
    for (const tour of CONTEXTUAL_TOURS) {
      expect(tour.steps[0]?.requiredForStart).toBe(true)
      const stepCount = (tour.steps as readonly unknown[]).length
      if (stepCount === 1) {
        expect(
          (tour.steps[0] as ContextualTour['steps'][number]).advanceOnFeatureInteraction
        ).toBeTruthy()
      } else {
        expect(stepCount).toBeGreaterThanOrEqual(2)
      }
      expect(stepCount).toBeLessThanOrEqual(tour.id === 'workspace-agent-sessions' ? 5 : 3)
      for (const step of tour.steps) {
        expect(step.title.length).toBeGreaterThan(0)
        expect(step.body.length).toBeGreaterThan(0)
        expect(step.body.length).toBeLessThanOrEqual(140)
        expect(step.targetSelector).toContain('data-contextual-tour-target')
      }
    }
  })

  it('defines the workspace agent sessions value tour as split then create-worktree', () => {
    const tour = CONTEXTUAL_TOURS.find((entry) => entry.id === 'workspace-agent-sessions') as
      | ContextualTour
      | undefined

    // Two steps only: tasks and orchestration education lives in their own
    // page tours, so the in-app tour ends after the worktree CTA.
    expect(tour?.steps.map((step) => step.title)).toEqual([
      'Split a terminal pane',
      'Start another task in parallel'
    ])
    // The opening step teaches the split gesture and offers the convenience button.
    expect(tour?.steps[0]).toMatchObject({
      requiredForStart: true,
      primaryAction: { kind: 'split-terminal-pane', label: 'Split terminal' },
      advanceOnFeatureInteraction: 'terminal-pane-split'
    })
    expect(tour?.steps[0]?.body).toContain('{terminal.splitRight}')
    expect(tour?.steps[0]?.targetSelector).toContain('terminal-pane-split-target')
    expect(tour?.steps[0]?.targetSelector).not.toContain('terminal-split-control')
    expect(tour?.steps[0]?.secondaryAction).toBeUndefined()
    // The closing step anchors on the real new-worktree button; the pulse makes
    // that button the CTA instead of duplicating it inside the panel.
    expect(tour?.steps[1]).toMatchObject({
      targetPulse: true,
      hidePrimaryAction: true
    })
    expect(tour?.steps[1]?.targetSelector).toContain('workspace-create-control')
    expect(tour?.steps[1]?.primaryAction).toBeUndefined()
    expect(tour?.steps[1]?.secondaryAction).toBeUndefined()
  })

  it('points the workspace board tour at the board center, done lane, and settings', () => {
    const tour = CONTEXTUAL_TOURS.find((entry) => entry.id === 'workspace-board') as
      | ContextualTour
      | undefined

    expect(tour?.steps.map((step) => step.title)).toEqual([
      'Plan work on the board',
      'Move work through lanes',
      'Tune density'
    ])
    expect(tour?.steps[0]).toMatchObject({
      targetSelector: '[data-contextual-tour-target="workspace-board-center"]',
      requiredForStart: true,
      preferredPlacement: 'bottom'
    })
    expect(tour?.steps[1]).toMatchObject({
      body: 'Drag workspaces between lanes as their status changes.',
      targetSelector:
        '[data-contextual-tour-target="workspace-board-done-lane"], [data-contextual-tour-target="workspace-board-lanes"]'
    })
    expect(tour?.steps[2]).toMatchObject({
      body: 'Use board settings to switch between detailed and compact cards.',
      targetSelector:
        '[data-contextual-tour-target="workspace-board-settings"], [data-contextual-tour-target="workspace-board-lanes"]'
    })
  })

  it('points the tasks tour at the row workspace action before toolbar fallbacks', () => {
    const tour = CONTEXTUAL_TOURS.find((entry) => entry.id === 'tasks') as
      | ContextualTour
      | undefined
    const step = tour?.steps[2]

    expect(step).toMatchObject({
      title: 'Start from work items',
      body: 'Use Start or Open on a task, issue, review, or merge request to bring its context into a workspace.'
    })
    expect(step?.targetSelector.split(', ')).toEqual([
      '[data-contextual-tour-target="tasks-start-workspace"]',
      '[data-contextual-tour-target="tasks-actions"]',
      '[data-contextual-tour-target="tasks-search-presets"]'
    ])
  })

  it('orders the automations tour as create, then results', () => {
    const tour = CONTEXTUAL_TOURS.find((entry) => entry.id === 'automations') as
      | ContextualTour
      | undefined

    expect(tour?.steps.map((step) => step.title)).toEqual([
      'What is an automation?',
      'Find the results'
    ])
    expect(tour?.steps[0]).toMatchObject({
      body: 'Automations run agent work on a schedule. Add an automation by clicking this button.',
      requiredForStart: true
    })
    expect(tour?.steps.map((step) => step.targetSelector)).toEqual([
      '[data-contextual-tour-target="automations-create"]',
      '[data-contextual-tour-target="automations-runs"]'
    ])
  })

  it('allows only workspace creation over its workspace composer modal', () => {
    const modalTours = (CONTEXTUAL_TOURS as readonly ContextualTour[]).filter(
      (tour) => tour.allowedActiveModals?.length
    )

    expect(modalTours.map((tour) => tour.id)).toEqual(['workspace-creation'])
    expect(modalTours[0]?.allowedActiveModals).toEqual(['new-workspace-composer'])
  })

  it('normalizes persisted ids by removing unknowns and duplicates', () => {
    expect(
      normalizeContextualTourIds([
        'tasks',
        'unknown',
        'workspace-agent-sessions',
        'browser',
        'tasks',
        null,
        'workspace-creation'
      ])
    ).toEqual(['tasks', 'workspace-agent-sessions', 'browser', 'workspace-creation'])
  })
})
