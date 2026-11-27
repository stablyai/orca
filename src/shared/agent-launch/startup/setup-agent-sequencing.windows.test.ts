import { copyFile, link, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { runProcess } from '@orca/process-host'
import { CLAUDE_HOOK_PLUGIN_DIR_ENV } from '../../agent-hook-listener/providers/claude/claude-hook-plugin'
import { getPowerShellAgentWrappers } from '../../shell/launch/agents/powershell-agent-wrappers'
import { quotePowerShellLiteral } from '../../shell/launch/powershell-native-argument'
import {
  createSequencedSetupAgentCommands,
  SETUP_AGENT_SEQUENCE_STARTUP_SCRIPT_ENV
} from './setup-agent-sequencing'

it('defines the agent wrappers in the Windows gate before running the startup command', () => {
  const sequenced = createSequencedSetupAgentCommands({
    runnerScriptPath: `C:\\${'worktree-dir\\'.repeat(18)}orca\\setup-runner.cmd`,
    startupCommand: 'claude',
    platform: 'windows'
  })
  // Longer gates are typed into the pane instead of passed in shell argv (shell-args.ts).
  expect(sequenced.startupCommand.length).toBeLessThanOrEqual(6000)
  expect(sequenced.startupEnv?.[SETUP_AGENT_SEQUENCE_STARTUP_SCRIPT_ENV]).toBe(
    getPowerShellAgentWrappers()
  )
  const gate = Buffer.from(sequenced.startupCommand.split(' ').at(-1) ?? '', 'base64').toString(
    'utf16le'
  )
  expect(gate).toMatch(
    /Invoke-Expression \$wrappers; Remove-Item Env:ORCA_SEQUENCED_STARTUP_SCRIPT .*Invoke-Expression \$startup/s
  )
})

// Why native: the gate always runs Windows PowerShell 5.1, whose argv marshalling is what splits the prompt.
it.skipIf(process.platform !== 'win32')(
  'delivers a prompt with embedded quotes to Claude once setup finishes',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-setup-gate-'))
    try {
      const claude = join(root, 'claude.exe')
      await link(process.execPath, claude).catch(() => copyFile(process.execPath, claude))
      const capture = join(root, 'argv.js')
      await writeFile(
        capture,
        `require('node:fs').writeFileSync(${JSON.stringify(join(root, 'argv.json'))}, JSON.stringify(process.argv.slice(2)))`
      )
      await writeFile(join(root, 'setup.cmd'), '@exit /b 0\r\n')
      const sequenced = createSequencedSetupAgentCommands({
        runnerScriptPath: join(root, 'setup.cmd'),
        startupCommand: `claude ${quotePowerShellLiteral(capture)} ${quotePowerShellLiteral('say "hello there" now')}`,
        platform: 'windows'
      })
      const env = Object.fromEntries(
        Object.entries(process.env).filter(([key]) => !key.startsWith('ORCA_'))
      )
      const pathKey = Object.keys(env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH'
      Object.assign(env, sequenced.startupEnv, {
        [pathKey]: `${root};${env[pathKey] ?? ''}`,
        [CLAUDE_HOOK_PLUGIN_DIR_ENV]: join(root, 'plugin')
      })
      for (const command of [sequenced.setupCommand, sequenced.startupCommand]) {
        const [program, ...args] = command.split(' ')
        const result = await runProcess({ program, args, cwd: root, env })
        expect(result.code, JSON.stringify(result)).toBe(0)
      }
      expect(JSON.parse(await readFile(join(root, 'argv.json'), 'utf8'))).toEqual([
        'say "hello there" now'
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
)
