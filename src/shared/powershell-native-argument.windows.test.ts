import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { runProcess } from '@orca/process-host'
import { quotePowerShellLiteral } from './powershell-native-argument'

async function captureNativeArgv(root: string, quotedArg: string): Promise<string[]> {
  const capturePath = join(root, 'argv.json')
  const scriptPath = join(root, 'capture.js')
  await writeFile(
    scriptPath,
    `require('node:fs').writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify(process.argv.slice(2)))`
  )
  const result = await runProcess({
    program: 'powershell.exe',
    args: [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `& ${quotePowerShellLiteral(process.execPath)} ${quotePowerShellLiteral(scriptPath)} ${quotedArg}`
    ],
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
    try {
      const plain = 'line one\r\nline two $HOME `tick\nO\u2019Brien \u201Cdouble\u201D end'
      expect(await captureNativeArgv(root, quotePowerShellLiteral(plain))).toEqual([plain])

      // Why compare with the old raw single-quoted form: 5.1 drops embedded `"` from native argv
      // either way, and the one-line form must not change what reaches the program.
      const withQuotes = 'say "hi"\nbye'
      const legacy = `'${withQuotes.replace(/'/g, "''")}'`
      expect(await captureNativeArgv(root, quotePowerShellLiteral(withQuotes))).toEqual(
        await captureNativeArgv(root, legacy)
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
)
