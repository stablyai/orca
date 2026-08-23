import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runProcess } from './child-process/run-process'
import {
  buildClaudeAgentTeamsPowerShellCommand,
  parseClaudeAgentTeamsPaneLaunch,
  resolveClaudeAgentTeamsPaneSpawn
} from './claude-agent-teams-pane-launch'

const TEAMMATE_COMMAND =
  "cd 'E:\\Repos\\demo' && env CLAUDECODE=1 CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1 " +
  "'C:\\Users\\dev\\.local\\bin\\claude.exe' --agent-name Nova --agent-color blue --model opus"

describe('Claude Agent Teams pane launch', () => {
  it('parses Claude shell text into executable, cwd, and environment data', () => {
    expect(parseClaudeAgentTeamsPaneLaunch(TEAMMATE_COMMAND)).toEqual({
      argv: [
        'C:\\Users\\dev\\.local\\bin\\claude.exe',
        '--agent-name',
        'Nova',
        '--agent-color',
        'blue',
        '--model',
        'opus'
      ],
      cwd: 'E:\\Repos\\demo',
      env: { CLAUDECODE: '1', CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1' },
      holding: false
    })
  })

  it('renders only argv for PowerShell and keeps cwd/env structured', () => {
    expect(
      resolveClaudeAgentTeamsPaneSpawn({ command: TEAMMATE_COMMAND, shell: 'powershell' })
    ).toEqual({
      cwd: 'E:\\Repos\\demo',
      env: { CLAUDECODE: '1', CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1' },
      process: {
        argv: [
          'C:\\Users\\dev\\.local\\bin\\claude.exe',
          '--agent-name',
          'Nova',
          '--agent-color',
          'blue',
          '--model',
          'opus'
        ],
        holding: false
      }
    })
  })

  it('uses a silent PowerShell holding command', () => {
    expect(
      resolveClaudeAgentTeamsPaneSpawn({
        command: 'cat',
        shell: 'powershell',
        tmuxCwd: 'E:\\Repos\\demo'
      })
    ).toEqual({
      cwd: 'E:\\Repos\\demo',
      env: {},
      process: { argv: ['cat'], holding: true }
    })
  })

  it('rejects shell programs outside the Claude-owned shape', () => {
    expect(parseClaudeAgentTeamsPaneLaunch("cd '/repo' && claude | tee log")).toBeNull()
    expect(parseClaudeAgentTeamsPaneLaunch("cd '/repo")).toBeNull()
    expect(() =>
      resolveClaudeAgentTeamsPaneSpawn({ command: 'claude | tee log', shell: 'powershell' })
    ).toThrow('unsupported Claude teammate pane command')
  })

  it('preserves quoted shell metacharacters while rejecting live operators', () => {
    expect(
      parseClaudeAgentTeamsPaneLaunch("env CLAUDECODE=1 claude --agent-name 'R&D'")?.argv
    ).toEqual(['claude', '--agent-name', 'R&D'])
    expect(parseClaudeAgentTeamsPaneLaunch('env CLAUDECODE=1 claude --agent-name R&D')).toBeNull()
    expect(parseClaudeAgentTeamsPaneLaunch('env SAFE=1& claude --agent-name Nova')).toBeNull()
    expect(parseClaudeAgentTeamsPaneLaunch('cd /repo;evil && env SAFE=1 claude')).toBeNull()
    expect(parseClaudeAgentTeamsPaneLaunch("cd '/repo' '&&' env SAFE=1 claude")).toBeNull()
  })

  it('does not rewrite POSIX pane commands', () => {
    expect(resolveClaudeAgentTeamsPaneSpawn({ command: TEAMMATE_COMMAND, shell: 'posix' })).toEqual(
      { command: TEAMMATE_COMMAND, cwd: undefined, env: {} }
    )
  })

  it.skipIf(process.platform !== 'win32')(
    'preserves batch-sensitive argv through a real PowerShell pane command',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'orca-teammate-cmd-'))
      const script = join(dir, 'claude test.cmd')
      writeFileSync(
        script,
        `@echo off\r\n"${process.execPath}" -e "process.stdout.write(JSON.stringify(process.argv.slice(1)))" %*\r\n`
      )
      const args = ['space value', 'ampersand&value', 'caret^value', 'percent%value', 'bang!value']
      try {
        const command = buildClaudeAgentTeamsPowerShellCommand([script, ...args])
        const result = await runProcess({
          program: 'powershell.exe',
          args: ['-NoLogo', '-NoProfile', '-Command', command]
        })
        expect(result.code).toBe(0)
        expect(JSON.parse(result.stdout)).toEqual(args)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }
  )
})
