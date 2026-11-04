export const AGENT_SESSION_GOAL_CONTROL_COPY = {
  settingsRejected:
    'Codex could not apply the selected model and effort. This goal change was not sent. Check the selection and try again.',
  settingsUnconfirmed:
    'Codex did not confirm the selected model and effort. This goal change was not sent. Check the chat and try again.',
  pauseUnconfirmed:
    'Codex stopped running, but its goal pause was not confirmed. Check the goal before continuing.',
  stopUnconfirmed: 'Codex could not confirm Stop. Check the chat before continuing.',
  noGoal: 'Codex has no goal to change in this chat. Set one with /goal followed by the objective.'
} as const
