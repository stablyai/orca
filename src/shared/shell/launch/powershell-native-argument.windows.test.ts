import 'smol-toml'
import '../../orca-profiles/constants'
import '../../source-control/ai/settings/source-control-ai-recipe-save'
import '../../source-control/ai/source-control-ai-operation-policy'
import '../../source-control/ai/recipes/source-control-action-launch-preferences'
import '../../agent-launch/startup/agent-startup-plan-inputs'
import '../../agent-launch/startup/tui-agent-startup'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runProcess } from '@orca/process-host'
import './agents/powershell-agent-wrappers'
import { getPowerShellCodexShellLaunchPreflight } from './agents/codex-shell-function'
import {
  getPowerShellEscapeNativeArgsFunction,
  quotePowerShellLiteral
} from './powershell-native-argument'

/** Runs `build(native)` in `powershell`, where `native` invokes a program that records its argv. */
async function captureNativeArgv(
  root: string,
  powershell: string,
  build: (native: string) => string
): Promise<string[]> {
  const capturePath = join(root, 'argv.json')
  const scriptPath = join(root, 'capture.js')
  await writeFile(
    scriptPath,
    `require('node:fs').writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify(process.argv.slice(2)))`
  )
  const native = `& ${quotePowerShellLiteral(process.execPath)} ${quotePowerShellLiteral(scriptPath)}`
  const result = await runProcess({
    program: powershell,
    args: ['-NoProfile', '-NonInteractive', '-Command', build(native)],
    cwd: root
  })
  expect(result.code, JSON.stringify(result)).toBe(0)
  const argv: string[] = JSON.parse(await readFile(capturePath, 'utf8'))
  return argv
}

// Why native: argv marshalling, not the generated text, is what a launched agent actually receives.

const isWindows = process.platform === 'win32'

it.skipIf(!isWindows)(
  'runs npm Codex past a policy-blocked shim with its args, stdin and exit code',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca npm codex '))
    try {
      const bin = join(root, 'node_modules', '@openai', 'codex', 'bin')
      await mkdir(bin, { recursive: true })
      await writeFile(join(root, 'codex.ps1'), "throw 'unexpected PowerShell shim'")
      await writeFile(
        join(bin, 'codex.js'),
        "if (process.argv.includes('--help')) console.log('--no-daemon'); else { console.log(process.argv.slice(2).join('|')); process.stdin.pipe(process.stdout); process.exitCode = 17 }"
      )
      const result = await runProcess({
        program: 'powershell.exe',
        args: [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Restricted',
          '-Command',
          [
            "$ErrorActionPreference = 'Stop'",
            `$env:PATH = ${quotePowerShellLiteral(`${root};`)} + $env:PATH`,
            getPowerShellEscapeNativeArgsFunction(),
            getPowerShellCodexShellLaunchPreflight(),
            "'from stdin' | codex 'arg & value'",
            'exit $LASTEXITCODE'
          ].join('\n')
        ],
        cwd: root,
        env: {
          ...Object.fromEntries(
            Object.entries(process.env).filter(([k]) => !k.startsWith('ORCA_'))
          ),
          ORCA_PANE_KEY: 'pane'
        }
      })
      expect(result.code, JSON.stringify(result)).toBe(17)
      expect(result.stdout.trim().split(/\r?\n/)).toEqual([
        "--no-daemon|-c|shell_environment_policy.set.ORCA_PANE_KEY='pane'|arg & value",
        'from stdin'
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
)

const pwshAvailable =
  isWindows &&
  spawnSync('pwsh.exe', ['-NoProfile', '-Command', 'exit 0'], { windowsHide: true }).status === 0

const POWERSHELLS = [
  { name: 'Windows PowerShell', powershell: 'powershell.exe', prelude: '', available: isWindows },
  { name: 'pwsh', powershell: 'pwsh.exe', prelude: '', available: pwshAvailable },
  {
    name: 'pwsh with Legacy passing',
    powershell: 'pwsh.exe',
    prelude: "$PSNativeCommandArgumentPassing = 'Legacy'",
    available: pwshAvailable
  }
]

describe.each(POWERSHELLS)(
  '__OrcaEscapeNativeArgs under $name',
  ({ powershell, prelude, available }) => {
    it.skipIf(!available)('delivers embedded quotes and backslashes exactly', async () => {
      const root = await mkdtemp(join(tmpdir(), 'orca-ps-native-args-'))
      try {
        for (const value of [
          'say "hi" to "bob"',
          'line1 "a"\nline2 "b c"',
          'path C:\\dir\\" end "q"',
          'a "" b',
          'a"b',
          'a"b c"d',
          '"fix the login bug"',
          'look in C:\\dir\\',
          'look in C:\\dir\\\n',
          'C:\\no-space\\',
          'C:\\no-space\\\n',
          'model_reasoning_effort="high"',
          'model="true"',
          'model="42"',
          'model="a\\"b"',
          '{"fastMode":false,"theme":"light","env":{"KEEP":"yes"}}',
          'Fix " --dangerously-bypass-approvals-and-sandbox " thanks'
        ]) {
          // Why assign then splat: the agent wrappers hand their $args to the program this way.
          const argv = await captureNativeArgv(
            root,
            powershell,
            (native) =>
              `${prelude}\n${getPowerShellEscapeNativeArgsFunction()}\n` +
              `function agent { $a = @(__OrcaEscapeNativeArgs 'node.exe' $args); ${native} @a }\n` +
              `agent ${quotePowerShellLiteral(value)}`
          )
          expect(argv).toEqual([value])
        }
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    })
  }
)
