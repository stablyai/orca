import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { planHermesStartupQuery } from './hermes-startup-query'

const windowsIt = process.platform === 'win32' ? it : it.skip

windowsIt('preserves the startup query and spaced custom args in native Windows argv', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'orca-hermes-startup-query-'))
  const capturePath = join(tempDir, 'argv.json')
  const hermesPath = join(tempDir, 'hermes.exe')
  const prompt = [
    'Return the marker with quoted="alpha beta" and unicode=雪🚀.',
    'Keep %PATH% literal.',
    '--version'
  ].join('\n')

  try {
    // Why: the Node executable is a real native Windows process, so this catches
    // PowerShell argument marshalling bugs that generated-script assertions miss.
    copyFileSync(process.execPath, hermesPath)
    writeFileSync(
      join(tempDir, 'chat'),
      `require('node:fs').writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify(process.argv.slice(2)))`
    )
    const plan = planHermesStartupQuery({
      baseCommand: `"${hermesPath}"`,
      agentArgs: '--yolo --source "Orca automation validation"',
      prompt,
      platform: 'win32',
      shell: 'powershell'
    })
    const encodedCommand = plan?.command.match(/-EncodedCommand\s+(\S+)/)?.[1]

    expect(encodedCommand).toBeDefined()
    execFileSync('powershell.exe', ['-NoProfile', '-EncodedCommand', encodedCommand!], {
      cwd: tempDir,
      env: { ...process.env, ...plan?.env }
    })
    expect(JSON.parse(readFileSync(capturePath, 'utf8'))).toEqual([
      `--query=${prompt}`,
      '--yolo',
      '--source',
      'Orca automation validation',
      '--tui'
    ])
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
})
