/** Where a pane's Hermes runs: the local machine, a WSL distro (via its workspace) or an SSH host. */
export type HermesLaunchProfileRequest = {
  executionHostId?: string
  /** The workspace the pane launches into; its path names the WSL distro on Windows. */
  worktreeId?: string
}

/** Named Hermes profiles the desktop can launch: read from Hermes' home on demand. */
export type HermesLaunchProfiles = {
  /** Profile ids under `<root>/profiles/`, sorted; empty when none exist. */
  profiles: string[]
  /** The sticky `hermes profile use` choice, or null when the root home is active. */
  active: string | null
}
