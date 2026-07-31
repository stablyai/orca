export const DAEMON_SESSION_ROUTING_UNAVAILABLE_MARKER = 'daemon_session_routing_unavailable'

export function isDaemonSessionRoutingUnavailable(message: string): boolean {
  return message.includes(DAEMON_SESSION_ROUTING_UNAVAILABLE_MARKER)
}
