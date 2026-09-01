// Why: relays and clients update independently, and a relay that predates the launch-token
// echo accepts `launchToken` on pty.spawn but never reports it back from pty.listProcesses.
// Crash reconciliation reads that missing echo as "the launch's terminal died" and settles
// spawn_failed, so the user's Retry spawns a DUPLICATE agent beside the live one. The version
// is advertised through pty.getCapabilities so main can withhold the token and fall back to
// non-token identification instead of assuming a round trip the peer cannot make.
export const LAUNCH_TOKEN_ECHO_PROTOCOL_VERSION = 1 as const
