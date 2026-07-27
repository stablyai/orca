// Types for host session discovery: enumerating pre-existing terminal
// multiplexer (tmux) sessions on an SSH host and classifying which coding agent
// each one is running. Unlike Orca's own workspace sessions, these are sessions
// Orca does not own — they were started outside Orca (e.g. a bare `tmux` + agent
// on the remote) and can only be observed by probing the host.

export type HostSessionAgent = 'claude' | 'codex' | null

export type HostSession = {
  /** tmux session name. */
  session: string
  /** pane_current_path — working directory of the pane. */
  cwd: string
  /** pane_current_command — foreground command tmux reports for the pane. */
  command: string
  /** True when at least one client is attached to the session. */
  attached: boolean
  /** Agent detected by walking the pane's process subtree, or null if none. */
  agent: HostSessionAgent
  /** git branch at `cwd`, if the path is inside a repository. */
  branch?: string
  /** pane_pid — root of the process subtree used for agent classification. */
  pid?: number
}

export type HostSessionsResult = {
  sessions: HostSession[]
  /** False when tmux is not installed or no server is running on the host. */
  tmuxAvailable: boolean
}
