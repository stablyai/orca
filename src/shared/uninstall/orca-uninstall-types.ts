/** How this copy of Orca was installed; decides the last step the user takes to delete the app. */
export type OrcaUninstallInstallKind =
  | 'mac-app'
  | 'mac-homebrew'
  | 'windows-installer'
  | 'linux-appimage'
  | 'linux-package'
  | 'unknown'

/** One part of the cleanup, run in this order. */
export type OrcaUninstallStep =
  | 'agent-hooks'
  | 'cli-command'
  | 'background-service'
  | 'hook-scripts'
  | 'ssh-hosts'

export const ORCA_UNINSTALL_STEPS: readonly OrcaUninstallStep[] = [
  'agent-hooks',
  'cli-command',
  'background-service',
  'hook-scripts',
  'ssh-hosts'
]

/**
 * `kept-shared`: another Orca build still uses it, so it stays.
 * `needs-user`: Orca can't do it from here (an offline SSH host); the entry names what to run.
 */
export type OrcaUninstallEntryState = 'present' | 'removed' | 'kept-shared' | 'needs-user' | 'error'

export type OrcaUninstallAgentEntry = {
  agent: string
  /** Every file Orca changes or deletes for this agent. */
  paths: string[]
  state: OrcaUninstallEntryState
  /** One short line, e.g. "Permission denied". */
  detail: string | null
}

export type OrcaUninstallHostEntry = {
  hostId: string
  label: string
  connected: boolean
  state: OrcaUninstallEntryState
  detail: string | null
  /** Run on the host by hand when it can't be reached. */
  manualCommand: string | null
}

export type OrcaUninstallSimpleEntry = {
  /** What the row shows on the right: a path, a command name, or a service label. */
  location: string
  state: OrcaUninstallEntryState
  detail: string | null
}

/** What would change, and after a step runs, what did. Steps with nothing to do are null or empty. */
export type OrcaUninstallPlan = {
  installKind: OrcaUninstallInstallKind
  agents: OrcaUninstallAgentEntry[]
  cliCommand: (OrcaUninstallSimpleEntry & { commandName: string }) | null
  backgroundService: OrcaUninstallSimpleEntry | null
  hookScripts: OrcaUninstallSimpleEntry | null
  hosts: OrcaUninstallHostEntry[]
  /** Set when another Orca build (stable, RC or dev) still uses the shared hooks. */
  otherOrcaBuildName: string | null
  /** The app bundle, AppImage or install folder to reveal, when there is one. */
  appPath: string | null
  /** The command that deletes the app when the OS needs one (Homebrew, apt, dnf). */
  removeAppCommand: string | null
}

export type OrcaUninstallRunStepArgs = {
  step: OrcaUninstallStep
  /** Retry only these agents or hosts. */
  only?: string[]
}

export type OrcaUninstallFinishAction = 'quit' | 'reveal-app' | 'open-windows-uninstaller'
