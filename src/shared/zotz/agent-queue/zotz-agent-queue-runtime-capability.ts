// Why: a paired client reads another host's memory queue only when that host declares it; older hosts omit it.
export const ZOTZ_AGENT_QUEUE_RUNTIME_CAPABILITY = 'zotz.agent-queue.v1' as const

// Why separate: a host that publishes its queue may predate the calls that cancel or force a launch.
export const ZOTZ_AGENT_QUEUE_CONTROL_RUNTIME_CAPABILITY = 'zotz.agent-queue-control.v1' as const

export const ZOTZ_RUNTIME_CAPABILITIES = [
  ZOTZ_AGENT_QUEUE_RUNTIME_CAPABILITY,
  ZOTZ_AGENT_QUEUE_CONTROL_RUNTIME_CAPABILITY
] as const
