import { translate } from '@/i18n/i18n'

// Why: keyed by the step's stable id, not its position — inserting a step must
// not shift localized copy onto a neighbour. Thunks keep translate() out of
// module scope so the lookup resolves in the language active at render time.
export const LOCALIZED_STEP_COPY: Record<string, { title: () => string; body: () => string }> = {
  'automations-intro': {
    title: () =>
      translate(
        'auto.components.contextual.tours.contextual.tour.step.localized.copy.dc2d7ebbfa',
        'What is an automation?'
      ),
    body: () =>
      translate(
        'auto.components.contextual.tours.contextual.tour.step.localized.copy.1a9ac96bc5',
        'Automations run agent work on a schedule. Add an automation by clicking this button.'
      )
  },
  'automations-results': {
    title: () =>
      translate(
        'auto.components.contextual.tours.contextual.tour.step.localized.copy.e69e126045',
        'Find the results'
      ),
    body: () =>
      translate(
        'auto.components.contextual.tours.contextual.tour.step.localized.copy.65a7cf9b63',
        'Runs show when automations ran, what happened, and where to inspect their output.'
      )
  },
  'workspace-agent-sessions-split-pane': {
    title: () =>
      translate(
        'auto.components.contextual.tours.contextual.tour.step.localized.copy.c1fc08cd8f',
        'Split a terminal pane'
      ),
    body: () =>
      translate(
        'auto.components.contextual.tours.contextual.tour.step.localized.copy.0376fb14f8',
        'Open a second terminal pane with {terminal.splitRight}, or right-click the pane for split options.'
      )
  },
  'workspace-agent-sessions-parallel-task': {
    title: () =>
      translate(
        'auto.components.contextual.tours.contextual.tour.step.localized.copy.6170819178',
        'Start another task in parallel'
      ),
    body: () =>
      translate(
        'auto.components.contextual.tours.contextual.tour.step.localized.copy.2342da9c9f',
        'Each worktree gets its own branch, so parallel work stays separate.'
      )
  },
  'workspace-creation-project': {
    title: () =>
      translate(
        'auto.components.contextual.tours.contextual.tour.step.localized.copy.67991d08bb',
        'Pick a project'
      ),
    body: () =>
      translate(
        'auto.components.contextual.tours.contextual.tour.step.localized.copy.3995148eb8',
        'Orca isolates each task in its own worktree, branched off your base.'
      )
  },
  'workspace-creation-name': {
    title: () =>
      translate(
        'auto.components.contextual.tours.contextual.tour.step.localized.copy.128db835f5',
        'Name it, or start from existing work'
      ),
    body: () =>
      translate(
        'auto.components.contextual.tours.contextual.tour.step.localized.copy.6976d66061',
        'Start from a linked task for a short issue or PR name. Or leave it blank to auto-name it from your first agent message.'
      )
  },
  'workspace-creation-agent': {
    title: () =>
      translate(
        'auto.components.contextual.tours.contextual.tour.step.localized.copy.f780b45969',
        'Choose what agent starts the work'
      ),
    body: () =>
      translate(
        'auto.components.contextual.tours.contextual.tour.step.localized.copy.0314261987',
        'Pick the agent that should be opened when this worktree is created.'
      )
  },
  'tasks-work-source': {
    title: () =>
      translate(
        'auto.components.contextual.tours.contextual.tour.step.localized.copy.7cf856f55d',
        'Choose the work source'
      ),
    body: () =>
      translate(
        'auto.components.contextual.tours.contextual.tour.step.localized.copy.78aa70314e',
        'Switch between connected providers and project filters without changing pages.'
      )
  },
  'tasks-filter-work': {
    title: () =>
      translate(
        'auto.components.contextual.tours.contextual.tour.step.localized.copy.f392edd975',
        'Filter to the work you need'
      ),
    body: () =>
      translate(
        'auto.components.contextual.tours.contextual.tour.step.localized.copy.15ea06d23f',
        'Use presets and search to narrow issues, reviews, merge requests, or tasks.'
      )
  },
  'tasks-start-from-items': {
    title: () =>
      translate(
        'auto.components.contextual.tours.contextual.tour.step.localized.copy.819bcf6f00',
        'Start from work items'
      ),
    body: () =>
      translate(
        'auto.components.contextual.tours.contextual.tour.step.localized.copy.be99666806',
        'Use Start or Open on a task, issue, review, or merge request to bring its context into a workspace.'
      )
  },
  'workspace-board-plan': {
    title: () =>
      translate(
        'auto.components.contextual.tours.contextual.tour.step.localized.copy.a1b2c3d4e5',
        'Plan work on the board'
      ),
    body: () =>
      translate(
        'auto.components.contextual.tours.contextual.tour.step.localized.copy.f6g7h8i9j0',
        'Use the board when you want to see workspaces by status instead of by project.'
      )
  },
  'workspace-board-lanes': {
    title: () =>
      translate(
        'auto.components.contextual.tours.contextual.tour.step.localized.copy.k1l2m3n4o5',
        'Move work through lanes'
      ),
    body: () =>
      translate(
        'auto.components.contextual.tours.contextual.tour.step.localized.copy.p6q7r8s9t0',
        'Drag workspaces between lanes as their status changes.'
      )
  }
}

export function localizeTourActionLabel(label: string): string {
  if (label === 'Split terminal') {
    return translate(
      'auto.components.contextual.tours.contextual.tour.step.localized.copy.31ca5cb3e0',
      'Split terminal'
    )
  }
  if (label === 'Next') {
    return translate(
      'auto.components.contextual.tours.contextual.tour.step.localized.copy.012036e8ca',
      'Next'
    )
  }
  return label
}
