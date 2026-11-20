// Why: a paired client reads another host's memory queue only when that host declares it; older hosts omit it.
export const ZOTZ_AGENT_QUEUE_RUNTIME_CAPABILITY = 'zotz.agent-queue.v1' as const

export const ZOTZ_RUNTIME_CAPABILITIES = [ZOTZ_AGENT_QUEUE_RUNTIME_CAPABILITY] as const
