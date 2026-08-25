import { translate } from '@/i18n/i18n'

export type LocalizedContextualTourStepCopy = {
  title: string
  body: string
  primaryActionLabel?: string
}

// Automations keys are unchanged from the original fix so its shipped translations still resolve.

// Why: keyed by the step's stable id, not its position — inserting a step must
// not shift localized copy onto a neighbour. Thunks keep translate() out of
// module scope so the lookup resolves in the language active at render time.
const LOCALIZED_STEP_COPY: Record<string, () => LocalizedContextualTourStepCopy> = {
  'workspace-board-plan': () => ({
    title: translate(
      'auto.components.contextual.tours.contextual.tour.step.copy.workspace.board.plan.title',
      'Plan work on the board'
    ),
    body: translate(
      'auto.components.contextual.tours.contextual.tour.step.copy.workspace.board.plan.body',
      'Use the board when you want to see workspaces by status instead of by project.'
    )
  }),
  'workspace-board-lanes': () => ({
    title: translate(
      'auto.components.contextual.tours.contextual.tour.step.copy.workspace.board.lanes.title',
      'Move work through lanes'
    ),
    body: translate(
      'auto.components.contextual.tours.contextual.tour.step.copy.workspace.board.lanes.body',
      'Drag workspaces between lanes as their status changes.'
    )
  }),
  'agent-sessions-split': () => ({
    title: translate(
      'auto.components.contextual.tours.contextual.tour.step.copy.agent.sessions.split.title',
      'Split a terminal pane'
    ),
    body: translate(
      'auto.components.contextual.tours.contextual.tour.step.copy.agent.sessions.split.body',
      'Open a second terminal pane with {terminal.splitRight}, or right-click the pane for split options.'
    ),
    primaryActionLabel: translate(
      'auto.components.contextual.tours.contextual.tour.step.copy.agent.sessions.split.action',
      'Split terminal'
    )
  }),
  'agent-sessions-parallel': () => ({
    title: translate(
      'auto.components.contextual.tours.contextual.tour.step.copy.agent.sessions.parallel.title',
      'Start another task in parallel'
    ),
    body: translate(
      'auto.components.contextual.tours.contextual.tour.step.copy.agent.sessions.parallel.body',
      'Each worktree gets its own branch, so parallel work stays separate.'
    )
  }),
  'browser-grab': () => ({
    title: translate(
      'auto.components.contextual.tours.contextual.tour.step.copy.browser.grab.title',
      'Grab page context for agents'
    ),
    body: translate(
      'auto.components.contextual.tours.contextual.tour.step.copy.browser.grab.body',
      "Use the grab tool to copy a page element's context for agents."
    )
  }),
  'browser-annotate': () => ({
    title: translate(
      'auto.components.contextual.tours.contextual.tour.step.copy.browser.annotate.title',
      'Mark design feedback in place'
    ),
    body: translate(
      'auto.components.contextual.tours.contextual.tour.step.copy.browser.annotate.body',
      'Annotate elements and send those notes to an agent.'
    )
  }),
  'browser-logins': () => ({
    title: translate(
      'auto.components.contextual.tours.contextual.tour.step.copy.browser.logins.title',
      'Stay logged in'
    ),
    body: translate(
      'auto.components.contextual.tours.contextual.tour.step.copy.browser.logins.body',
      'Bring your existing logins into Orca to stay signed in immediately.'
    )
  }),
  'tasks-source': () => ({
    title: translate(
      'auto.components.contextual.tours.contextual.tour.step.copy.tasks.source.title',
      'Choose the work source'
    ),
    body: translate(
      'auto.components.contextual.tours.contextual.tour.step.copy.tasks.source.body',
      'Switch between connected providers and project filters without changing pages.'
    )
  }),
  'tasks-filter': () => ({
    title: translate(
      'auto.components.contextual.tours.contextual.tour.step.copy.tasks.filter.title',
      'Filter to the work you need'
    ),
    body: translate(
      'auto.components.contextual.tours.contextual.tour.step.copy.tasks.filter.body',
      'Use presets and search to narrow issues, reviews, merge requests, or tasks.'
    )
  }),
  'tasks-start': () => ({
    title: translate(
      'auto.components.contextual.tours.contextual.tour.step.copy.tasks.start.title',
      'Start from work items'
    ),
    body: translate(
      'auto.components.contextual.tours.contextual.tour.step.copy.tasks.start.body',
      'Use Start or Open on a task, issue, review, or merge request to bring its context into a workspace.'
    )
  }),
  'automations-intro': () => ({
    title: translate(
      'auto.components.contextual.tours.contextual.tour.overlay.measurement.automations.intro.title',
      'What is an automation?'
    ),
    body: translate(
      'auto.components.contextual.tours.contextual.tour.overlay.measurement.automations.intro.body',
      'Automations run agent work on a schedule. Add an automation by clicking this button.'
    )
  }),
  'automations-results': () => ({
    title: translate(
      'auto.components.contextual.tours.contextual.tour.overlay.measurement.automations.results.title',
      'Find the results'
    ),
    body: translate(
      'auto.components.contextual.tours.contextual.tour.overlay.measurement.automations.results.body',
      'Runs show when automations ran, what happened, and where to inspect their output.'
    )
  }),
  'floating-workspace-repos': () => ({
    title: translate(
      'auto.components.contextual.tours.contextual.tour.step.copy.floating.workspace.repos.title',
      'Run an agent across every repo'
    ),
    body: translate(
      'auto.components.contextual.tours.contextual.tour.step.copy.floating.workspace.repos.body',
      'Agents here run in any folder you choose. Point one at the directory above your services to work across all your repos at once.'
    )
  }),
  'floating-workspace-scratchpad': () => ({
    title: translate(
      'auto.components.contextual.tours.contextual.tour.step.copy.floating.workspace.scratchpad.title',
      'Or use it as a scratchpad'
    ),
    body: translate(
      'auto.components.contextual.tours.contextual.tour.step.copy.floating.workspace.scratchpad.body',
      'Open agents, scratch terminals, notes, and browser tabs without cluttering the worktree you’re focused on.'
    )
  }),
  'workspace-creation-project': () => ({
    title: translate(
      'auto.components.contextual.tours.contextual.tour.step.copy.workspace.creation.project.title',
      'Pick a project'
    ),
    body: translate(
      'auto.components.contextual.tours.contextual.tour.step.copy.workspace.creation.project.body',
      'Orca isolates each task in its own worktree, branched off your base.'
    )
  }),
  'workspace-creation-name': () => ({
    title: translate(
      'auto.components.contextual.tours.contextual.tour.step.copy.workspace.creation.name.title',
      'Name it, or start from existing work'
    ),
    body: translate(
      'auto.components.contextual.tours.contextual.tour.step.copy.workspace.creation.name.body',
      'Start from a linked task for a short issue or PR name. Or leave it blank to auto-name it from your first agent message.'
    )
  }),
  'workspace-creation-agent': () => ({
    title: translate(
      'auto.components.contextual.tours.contextual.tour.step.copy.workspace.creation.agent.title',
      'Choose what agent starts the work'
    ),
    body: translate(
      'auto.components.contextual.tours.contextual.tour.step.copy.workspace.creation.agent.body',
      'Pick the agent that should be opened when this worktree is created.'
    )
  })
}

export function getLocalizedContextualTourStepCopy(
  stepId: string | undefined
): LocalizedContextualTourStepCopy | undefined {
  return stepId ? LOCALIZED_STEP_COPY[stepId]?.() : undefined
}
