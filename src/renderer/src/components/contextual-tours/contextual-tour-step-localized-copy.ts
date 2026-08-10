import { translate } from '@/i18n/i18n'

// Why: keyed by the step's stable id, not its position — inserting a step must
// not shift localized copy onto a neighbour. Thunks keep translate() out of
// module scope so the lookup resolves in the language active at render time.
export const LOCALIZED_STEP_COPY: Record<string, { title: () => string; body: () => string }> = {
  'automations-intro': {
    title: () =>
      translate(
        'auto.components.contextual.tours.contextual.tour.overlay.measurement.automations.intro.title',
        'What is an automation?'
      ),
    body: () =>
      translate(
        'auto.components.contextual.tours.contextual.tour.overlay.measurement.automations.intro.body',
        'Automations run agent work on a schedule. Add an automation by clicking this button.'
      )
  },
  'automations-results': {
    title: () =>
      translate(
        'auto.components.contextual.tours.contextual.tour.overlay.measurement.automations.results.title',
        'Find the results'
      ),
    body: () =>
      translate(
        'auto.components.contextual.tours.contextual.tour.overlay.measurement.automations.results.body',
        'Runs show when automations ran, what happened, and where to inspect their output.'
      )
  },
  'workspace-agent-sessions-split-pane': {
    title: () =>
      translate(
        'auto.components.contextual.tours.workspaceAgentSessions.splitPane.title',
        'Split a terminal pane'
      ),
    body: () =>
      translate(
        'auto.components.contextual.tours.workspaceAgentSessions.splitPane.body',
        'Open a second terminal pane with {terminal.splitRight}, or right-click the pane for split options.'
      )
  },
  'workspace-agent-sessions-parallel-task': {
    title: () =>
      translate(
        'auto.components.contextual.tours.workspaceAgentSessions.parallelTask.title',
        'Start another task in parallel'
      ),
    body: () =>
      translate(
        'auto.components.contextual.tours.workspaceAgentSessions.parallelTask.body',
        'Each worktree gets its own branch, so parallel work stays separate.'
      )
  },
  'workspace-creation-project': {
    title: () =>
      translate(
        'auto.components.contextual.tours.workspaceCreation.project.title',
        'Pick a project'
      ),
    body: () =>
      translate(
        'auto.components.contextual.tours.workspaceCreation.project.body',
        'Orca isolates each task in its own worktree, branched off your base.'
      )
  },
  'workspace-creation-name': {
    title: () =>
      translate(
        'auto.components.contextual.tours.workspaceCreation.name.title',
        'Name it, or start from existing work'
      ),
    body: () =>
      translate(
        'auto.components.contextual.tours.workspaceCreation.name.body',
        'Start from a linked task for a short issue or PR name. Or leave it blank to auto-name it from your first agent message.'
      )
  },
  'workspace-creation-agent': {
    title: () =>
      translate(
        'auto.components.contextual.tours.workspaceCreation.agent.title',
        'Choose what agent starts the work'
      ),
    body: () =>
      translate(
        'auto.components.contextual.tours.workspaceCreation.agent.body',
        'Pick the agent that should be opened when this worktree is created.'
      )
  },
  'tasks-work-source': {
    title: () =>
      translate(
        'auto.components.contextual.tours.tasks.workSource.title',
        'Choose the work source'
      ),
    body: () =>
      translate(
        'auto.components.contextual.tours.tasks.workSource.body',
        'Switch between connected providers and project filters without changing pages.'
      )
  },
  'tasks-filter-work': {
    title: () =>
      translate(
        'auto.components.contextual.tours.tasks.filterWork.title',
        'Filter to the work you need'
      ),
    body: () =>
      translate(
        'auto.components.contextual.tours.tasks.filterWork.body',
        'Use presets and search to narrow issues, reviews, merge requests, or tasks.'
      )
  },
  'tasks-start-from-items': {
    title: () =>
      translate(
        'auto.components.contextual.tours.tasks.startFromItems.title',
        'Start from work items'
      ),
    body: () =>
      translate(
        'auto.components.contextual.tours.tasks.startFromItems.body',
        'Use Start or Open on a task, issue, review, or merge request to bring its context into a workspace.'
      )
  }
}

export function localizeTourActionLabel(label: string): string {
  if (label === 'Split terminal') {
    return translate(
      'auto.components.contextual.tours.workspaceAgentSessions.splitPane.action',
      'Split terminal'
    )
  }
  if (label === 'Next') {
    return translate(
      'auto.components.contextual.tours.contextual.tour.overlay.measurement.38b3155418',
      'Next'
    )
  }
  return label
}
