import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { buildGitLsFilesArgsForQuickOpen } from './quick-open-filter'

const execFileAsync = promisify(execFile)
const tempDirs: string[] = []

async function writeRel(root: string, relPath: string): Promise<void> {
  const absPath = join(root, ...relPath.split('/'))
  await mkdir(dirname(absPath), { recursive: true })
  await writeFile(absPath, 'x')
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
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
      ...Array.from({ length: 200 }, (_, index) =>
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
