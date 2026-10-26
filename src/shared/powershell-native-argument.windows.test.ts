import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runProcess } from '@orca/process-host'
import { getPowerShellAgentWrappers } from './powershell-agent-wrappers'
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
it.skipIf(process.platform !== 'win32')(
  'passes a multi-line value to a native program exactly as the single-quoted form did',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-ps-multiline-'))
    const capture = (quoted: string): Promise<string[]> =>
      captureNativeArgv(root, 'powershell.exe', (native) => `${native} ${quoted}`)
    try {
      const plain = 'line one\r\nline two $HOME `tick\nO\u2019Brien \u201Cdouble\u201D end'
      expect(await capture(quotePowerShellLiteral(plain))).toEqual([plain])

      // Compare old quoting too: 5.1 drops embedded quotes either way; the one-line change must preserve delivered argv.
      const withQuotes = 'say "hi"\nbye'
      const legacy = `'${withQuotes.replace(/'/g, "''")}'`
      expect(await capture(quotePowerShellLiteral(withQuotes))).toEqual(await capture(legacy))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
)

const isWindows = process.platform === 'win32'
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

describe.each(POWERSHELLS.slice(0, 2))(
  'agent wrappers under $name',
  ({ powershell, available }) => {
    it.skipIf(!available)(
      'hand a quoted prompt to a .cmd shim intact, without cmd running any of it',
      async () => {
        const root = await mkdtemp(join(tmpdir(), 'orca-ps-agent-wrappers-'))
        try {
          await writeFile(
            join(root, 'capture.js'),
            'console.log(JSON.stringify([require("node:path").parse(process.argv[2]).name, ...process.argv.slice(3)]))'
          )
          for (const agent of ['codex', 'claude']) {
            await writeFile(join(root, `${agent}.cmd`), `@node "%~dp0capture.js" "%~f0" %*\r\n`)
          }
          // Why this shape: escaping it as `\"` makes pwsh's .cmd quoting expose `&` to cmd.
          const prompt = 'a"b & echo INJECTED'
          const result = await runProcess({
            program: powershell,
            args: [
              '-NoProfile',
              '-NonInteractive',
              '-Command',
              `${getPowerShellAgentWrappers()}\ncodex ${quotePowerShellLiteral(prompt)}\nclaude ${quotePowerShellLiteral(prompt)}`
            ],
            cwd: root,
            env: {
              ...process.env,
              PATH: `${root};${process.env.PATH ?? ''}`,
              ORCA_CODEX_ISOLATE: '0',
              ORCA_CLAUDE_PROFILE_POINTER: join(root, 'no-pointer')
            }
          })

          expect(result.code, JSON.stringify(result)).toBe(0)
          expect(result.stdout.trim().split(/\r?\n/)).toEqual([
            JSON.stringify(['codex', prompt]),
            JSON.stringify(['claude', prompt])
          ])
        } finally {
          await rm(root, { recursive: true, force: true })
        }
      }
    )
  }
)
