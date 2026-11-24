// What `orca bot reply --leave-thread` tells the agent when Orca refuses it; nothing changed in each.
export const LEAVE_THREAD_REFUSALS = {
  not_a_thread:
    "Nothing changed: this chat doesn't answer a Slack thread you follow (a DM, GitHub or Linear can't be left this way).",
  leave_refused_stale:
    "Nothing changed: no request is running in this thread's chat now, so there's nothing to leave from.",
  leave_refused_mixed:
    "Nothing changed: this turn includes a message that isn't from a person who can ask you, so it can't be used to leave. Ask them to say it again on its own.",
  thread_mute_not_saved:
    "Nothing changed: Orca couldn't save that you left, so replies here still wake you. Say it didn't work."
} as const

export type LeaveThreadRefusalCode = keyof typeof LEAVE_THREAD_REFUSALS
