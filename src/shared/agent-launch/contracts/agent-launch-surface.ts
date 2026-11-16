/** Which surface a caller asked one launch to open: the agent's chat, or its CLI in a terminal. */
export const AGENT_LAUNCH_SURFACES = ['chat', 'terminal'] as const
export type AgentLaunchSurface = (typeof AGENT_LAUNCH_SURFACES)[number]

/** An explicit chat the host proved it cannot open, refused before anything was created. */
export const AGENT_LAUNCH_SURFACE_UNAVAILABLE_CODE = 'agent_launch_surface_unavailable'
