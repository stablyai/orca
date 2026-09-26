import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runProcessSync } from './child-process/run-process'
import { windowsSystem32Binary } from './child-process/windows-system-binary'
import { retargetClaudeAgentTeamsPaneCommand } from './claude-agent-teams-pane-command'

// Why real PowerShell: a failed Set-Location is non-terminating, which only running it shows.
const describeOnWindows = process.platform === 'win32' ? describe : describe.skip

function runInPowerShell(directory: string): string {
  const command = retargetClaudeAgentTeamsPaneCommand(
    `cd '${directory}' && ${windowsSystem32Binary('hostname.exe').replaceAll('\\', '/')}`,
    'powershell'
  )
  const result = runProcessSync({
    program: windowsSystem32Binary('WindowsPowerShell\\v1.0\\powershell.exe'),
    args: ['-NoProfile', '-NonInteractive', '-Command', command!]
  })
  return result.stdout.trim()
}

describeOnWindows('PowerShell teammate pane command', () => {
  it('launches from an existing directory', () => {
    expect(runInPowerShell(mkdtempSync(join(tmpdir(), 'orca-pane-cd-')))).not.toBe('')
  })

  it('does not launch when the directory change fails', () => {
    expect(runInPowerShell(join(tmpdir(), 'orca-pane-cd-missing', 'nope'))).toBe('')
  })
})
