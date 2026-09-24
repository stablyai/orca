// Why: Orca runs the user's shell with startup files loaded only to learn PATH or
// resolve commands. rc files that exec into a multiplexer or start a heavy prompt
// can check this variable and take a fast path. Shared by the desktop startup
// probe and the SSH relay's agent lookup so users only have one marker to guard on.
export const SHELL_PATH_PROBE_ENV_VAR = 'ORCA_SHELL_PATH_PROBE'
