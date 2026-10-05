// Why: the strip's roster now carries the host's running child records as views. A reader that
// predates it gets only the legacy task rows derived from them, never the views.
export const AGENT_SESSION_BACKGROUND_TASK_CHILD_VIEWS_CAPABILITY =
  'agent-session.background-task-child-views.v1' as const
