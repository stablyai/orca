import { describe, expect, it } from 'vitest'
import { buildFileExplorerScriptLaunch } from './file-explorer-script-command'

describe('file explorer startup command quoting', () => {
  it('keeps a POSIX filename with shell syntax literal and preserves the parent directory', () => {
    expect(buildFileExplorerScriptLaunch("/work dir/a'!\\; & $(x)`y`.bash", 'linux')).toEqual({
      command: `/bin/sh -c 'script=$(printf %b "$1"); if [ -x "$script" ]; then exec "$script"; fi; exec bash "$script"' sh '/work dir/a\\0047\\0041\\0134; & $(x)\`y\`.bash'`,
      startupCwd: '/work dir'
    })
  })

  it('passes ordinary and typographic quotes as PowerShell data', () => {
    expect(buildFileExplorerScriptLaunch("C:\\builds\\it's ‘ready’; & $()` .CMD", 'win32')).toEqual(
      {
        command: "& 'C:\\builds\\it''s ‘‘ready’’; & $()` .CMD'",
        startupCwd: 'C:\\builds',
        shell: 'powershell.exe'
      }
    )
    expect(buildFileExplorerScriptLaunch('D:\\build.ps1', 'win32')?.startupCwd).toBe('D:\\')
  })

  it('does not type control bytes or paths cmd could expand a second time', () => {
    expect(buildFileExplorerScriptLaunch('/work/bad\nname.sh', 'linux')).toBeNull()
    expect(buildFileExplorerScriptLaunch('C:\\%TEMP%\\build.cmd', 'win32')).toBeNull()
    expect(buildFileExplorerScriptLaunch('C:\\build!PATH!.bat', 'win32')).toBeNull()
  })

  it('uses the distro path only for a Windows-hosted WSL workspace', () => {
    const path = '//wsl.localhost/Ubuntu/work dir/file.sh'
    const windowsWsl = buildFileExplorerScriptLaunch(path, 'linux', true)
    expect(windowsWsl?.startupCwd).toBe('//wsl.localhost/Ubuntu/work dir')
    expect(windowsWsl?.command.endsWith(" sh '/work dir/file.sh'")).toBe(true)
    expect(
      buildFileExplorerScriptLaunch(path, 'linux')?.command.endsWith(
        " sh '//wsl.localhost/Ubuntu/work dir/file.sh'"
      )
    ).toBe(true)
  })
})
