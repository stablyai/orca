import type { GlobalSettings } from './global-settings-types'
import { WINDOWS_GIT_BASH_SHELL } from './windows-terminal-shell'

export type WindowsPowerShell = 'powershell.exe' | 'pwsh.exe'

/** The shell a local Windows pane runs; `wsl.exe` is the distro's POSIX login shell. */
export type WindowsPaneShell = WindowsPowerShell | 'cmd.exe' | 'git-bash' | 'wsl.exe'

export type WindowsShellSettings =
  | Partial<
      Pick<GlobalSettings, 'terminalWindowsShell' | 'terminalWindowsPowerShellImplementation'>
    >
  | null
  | undefined

/** What the host a launch runs on can do with its prompt, derived in one place from where it runs. */
export type LaunchHost = {
  /** Another Orca this client drives, possibly an older one: it is sent a command it may neither
   *  stage nor accompany with a launch file. Temporary, until paired hosts advertise both. */
  paired: boolean
  /** Whether the host can prove the launched agent holds its terminal before a paste
   *  (`launched-agent-foreground`). A Windows host cannot, so #24257's guarded paste is refused. */
  provesAgentInFront: boolean
  /** Whether the host writes a launch file the agent can read, and stages a long line, both in one
   *  folder. A paired Orca may be older, an SSH Windows host's relay may run its panes in WSL (its
   *  OpenSSH default shell, which this client cannot see), and a host may find that folder
   *  unwritable. Such a host gets the line (within its typed budget where it types raw, or by its
   *  Windows shell's verdict), or the paste, instead. */
  takesLaunchFile: boolean
  /** The shell a local Windows pane is spawned as, which the line is judged and quoted by: a WSL
   *  pane runs the distro's POSIX shell whatever the Windows setting, and the PowerShell decides
   *  how `"` and a trailing `\` reach the agent. Null where this Orca does not choose it (an SSH or
   *  paired host), or has not yet learned whether pwsh is installed. */
  windowsPaneShell: WindowsPaneShell | null
}

/**
 * The shell this host spawns for a local Windows pane, resolved as the spawn resolves it: the
 * requested shell, then the setting; for PowerShell, the implementation setting, then whether
 * pwsh.exe is installed. Null for a shell it cannot name (a custom path, or `bash.exe`, which may be
 * Git Bash or WSL), or a PowerShell before that probe answers.
 */
export function spawnedWindowsShell(args: {
  settings: WindowsShellSettings
  /** The shell this launch asked for, which outranks the setting. */
  windowsShellOverride?: string | null
  pwshAvailable: boolean | null
}): WindowsPaneShell | null {
  const shell = (args.windowsShellOverride ?? args.settings?.terminalWindowsShell ?? '').trim()
  if (shell === WINDOWS_GIT_BASH_SHELL) {
    return 'git-bash'
  }
  const name = shell
    .replaceAll('\\', '/')
    .split('/')
    .pop()
    ?.toLowerCase()
    .replace(/\.exe$/, '')
  if (name === 'pwsh' || name === 'cmd' || name === 'wsl') {
    return `${name}.exe`
  }
  if (name !== '' && name !== 'powershell') {
    return null
  }
  const implementation = args.settings?.terminalWindowsPowerShellImplementation
  if (implementation === 'powershell.exe' || implementation === 'pwsh.exe') {
    return implementation
  }
  return args.pwshAvailable === null ? null : args.pwshAvailable ? 'pwsh.exe' : 'powershell.exe'
}

/**
 * The launch host's facts. An SSH or paired host is judged by its own platform, a local one (a WSL
 * pane included, whose process reads run on Windows) by the machine running this Orca.
 */
export function describeLaunchHost(args: {
  /** The platform of the shell that types the launch line. */
  launchPlatform: NodeJS.Platform
  isRemote: boolean
  /** The platform of the machine this Orca runs on. */
  hostPlatform: NodeJS.Platform
  paired: boolean
  /** `spawnedWindowsShell` on this machine, which a launch elsewhere does not use. */
  windowsPaneShell?: WindowsPaneShell | null
  /** Whether the host can write the folder its staged lines and launch files go in. */
  writesLaunchArtifacts?: boolean
}): LaunchHost {
  const runsElsewhere = args.isRemote || args.paired
  return {
    paired: args.paired,
    provesAgentInFront: (runsElsewhere ? args.launchPlatform : args.hostPlatform) !== 'win32',
    takesLaunchFile:
      !args.paired &&
      !(args.isRemote && args.launchPlatform === 'win32') &&
      args.writesLaunchArtifacts !== false,
    windowsPaneShell:
      runsElsewhere || args.launchPlatform !== 'win32' ? null : (args.windowsPaneShell ?? null)
  }
}
