import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { removeTree } from '../file-write/windows-transient-lock-removal'
import { buildGitLsFilesArgsForQuickOpen } from './quick-open-filter'

// Why git plus fixture IO on a loaded Windows host exceeds the 30s global budget.
vi.setConfig({ testTimeout: 120_000 })

const execFileAsync = promisify(execFile)
const tempDirs: string[] = []

async function writeRel(root: string, relPath: string): Promise<void> {
  const absPath = join(root, ...relPath.split('/'))
  await mkdir(dirname(absPath), { recursive: true })
  await writeFile(absPath, 'x')
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => removeTree(dir)))
})

describe('Quick Open git directory collapse', () => {
  it('collapses unignored and ignored trees while preserving individual ignored files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-quick-open-git-collapse-'))
    tempDirs.push(root)
    await execFileAsync('git', ['init', '--quiet'], { cwd: root })
    await writeFile(
      join(root, '.gitignore'),
      ['.cache/', '.local/share/', 'dist/', '*.log'].join('\n')
    )
    await Promise.all([
      // Why: enough entries to prove tree collapse without stalling loaded runners.
      ...Array.from({ length: 20 }, (_, index) =>
        writeRel(root, `node_modules/pkg/file-${index}.js`)
      ),
      writeRel(root, '.cache/state.json'),
      writeRel(root, '.local/share/state.json'),
      writeRel(root, 'dist/generated.js'),
      writeRel(root, 'debug.log')
    ])

    const { primary, ignoredPass } = buildGitLsFilesArgsForQuickOpen()
    const [primaryResult, ignoredResult] = await Promise.all(
      [primary, ignoredPass].map((args) =>
        execFileAsync('git', ['-c', 'core.excludesFile=', 'ls-files', ...args], {
          cwd: root,
          encoding: 'buffer'
        })
      )
    )
    const primaryPaths = primaryResult.stdout.toString().split('\0').filter(Boolean)
    const ignoredPaths = ignoredResult.stdout.toString().split('\0').filter(Boolean)

    expect(primaryPaths).toEqual(['.gitignore', 'node_modules/'])
    expect(primaryPaths.some((path) => path.startsWith('node_modules/pkg/'))).toBe(false)
    expect(ignoredPaths).toEqual(['.cache/', '.local/', 'debug.log', 'dist/'])
    expect(ignoredPaths.some((path) => path.startsWith('.local/share/'))).toBe(false)
  })
})
