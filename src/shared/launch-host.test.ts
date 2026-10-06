import { describe, expect, it } from 'vitest'
import { describeLaunchHost, spawnedWindowsShell } from './launch-host'

describe('what a launch host can do with its prompt', () => {
  it.each([
    ['a local macOS host', false, false, 'darwin', 'darwin', true, true],
    ['a local Linux host', false, false, 'linux', 'linux', true, true],
    ['a local Windows host', false, false, 'win32', 'win32', false, true],
    // The pane runs in the distro, but the reads run on the Windows host; Orca writes into the distro.
    ['a local WSL pane', false, false, 'linux', 'win32', false, true],
    ['an SSH Linux host from Windows', true, false, 'linux', 'win32', true, true],
    // Its relay may run panes in WSL, where it writes no launch file; this client cannot tell.
    ['an SSH Windows host', true, false, 'win32', 'darwin', false, false],
    ['a paired Linux Orca from Windows', false, true, 'linux', 'win32', true, false],
    ['a paired Windows Orca from macOS', false, true, 'win32', 'darwin', false, false]
  ] as const)(
    '%s',
    (_label, isRemote, paired, launchPlatform, hostPlatform, proves, takesLaunchFile) => {
      expect(describeLaunchHost({ isRemote, paired, launchPlatform, hostPlatform })).toEqual({
        paired,
        provesAgentInFront: proves,
        takesLaunchFile,
        windowsPaneShell: null
      })
    }
  )
})

// Why: the PowerShell decides how `"` and a trailing `\` reach the agent, and this Orca picks it.
describe('the shell a local Windows pane is spawned as', () => {
  it.each([
    ['the pwsh shell', { terminalWindowsShell: 'pwsh.exe' }, undefined, null, 'pwsh.exe'],
    [
      'a requested pwsh over the setting',
      { terminalWindowsShell: 'cmd.exe' },
      'pwsh',
      null,
      'pwsh.exe'
    ],
    [
      'Windows PowerShell chosen explicitly',
      {
        terminalWindowsShell: 'powershell.exe',
        terminalWindowsPowerShellImplementation: 'powershell.exe'
      },
      undefined,
      true,
      'powershell.exe'
    ],
    [
      'auto with pwsh installed',
      { terminalWindowsShell: '', terminalWindowsPowerShellImplementation: 'auto' },
      undefined,
      true,
      'pwsh.exe'
    ],
    [
      'auto without pwsh',
      { terminalWindowsShell: 'powershell.exe', terminalWindowsPowerShellImplementation: 'auto' },
      undefined,
      false,
      'powershell.exe'
    ],
    [
      'auto before the probe answers',
      { terminalWindowsShell: 'powershell.exe', terminalWindowsPowerShellImplementation: 'auto' },
      undefined,
      null,
      null
    ],
    ['cmd', { terminalWindowsShell: 'cmd.exe' }, undefined, true, 'cmd.exe'],
    ['Git Bash', { terminalWindowsShell: 'git-bash' }, undefined, true, 'git-bash'],
    // The distro's POSIX shell, whatever PowerShell would have been.
    ['WSL', { terminalWindowsShell: 'wsl.exe' }, undefined, true, 'wsl.exe'],
    [
      'a requested WSL over a cmd setting',
      { terminalWindowsShell: 'cmd.exe' },
      'wsl',
      null,
      'wsl.exe'
    ],
    // Why unknown: System32's bash.exe is WSL, Git's is Git Bash.
    ['a bare bash.exe', { terminalWindowsShell: 'bash.exe' }, undefined, true, null]
  ] as const)('%s', (_label, settings, windowsShellOverride, pwshAvailable, expected) => {
    expect(spawnedWindowsShell({ settings, windowsShellOverride, pwshAvailable })).toBe(expected)
  })

  it('is not this machine’s to know for an SSH or paired host', () => {
    for (const where of [
      { isRemote: true, paired: false },
      { isRemote: false, paired: true }
    ]) {
      expect(
        describeLaunchHost({
          ...where,
          launchPlatform: 'win32',
          hostPlatform: 'win32',
          windowsPaneShell: 'powershell.exe'
        }).windowsPaneShell
      ).toBeNull()
    }
  })
})
