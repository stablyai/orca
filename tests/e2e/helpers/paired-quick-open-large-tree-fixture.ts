import { execFileSync } from 'node:child_process'
import {
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  renameSync,
  rmSync,
  truncateSync,
  writeFileSync
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const LARGE_TREE_FILE_COUNT = 88_763
export const LARGE_TREE_IGNORED_FILE_COUNT = 77_792
export const LARGE_TREE_NOMINAL_IGNORED_BYTES = 22 * 1024 * 1024 * 1024

const FILES_PER_DIRECTORY = 256
const LONG_STEM = 'remote-quick-open-transport-budget-path-'.repeat(2)

function createFiles(root: string, directoryName: string, count: number, extension: string): void {
  for (let start = 0; start < count; start += FILES_PER_DIRECTORY) {
    const directory = path.join(root, directoryName, `chunk-${String(start).padStart(6, '0')}`)
    mkdirSync(directory, { recursive: true })
    const end = Math.min(start + FILES_PER_DIRECTORY, count)
    for (let index = start; index < end; index++) {
      closeSync(
        openSync(
          path.join(directory, `${LONG_STEM}${String(index).padStart(6, '0')}.${extension}`),
          'w'
        )
      )
    }
  }
}

export type PairedQuickOpenLargeTreeFixture = {
  dispose: () => void
  gitIgnoredTargetPath: string
  orcaIgnoredTargetPath: string
  root: string
}

export function createPairedQuickOpenLargeTreeFixture(): PairedQuickOpenLargeTreeFixture {
  const root = mkdtempSync(path.join(os.tmpdir(), 'orca-paired-quick-open-large-tree-'))
  try {
    execFileSync('git', ['init'], { cwd: root, stdio: 'pipe' })
    writeFileSync(path.join(root, '.gitignore'), 'data/\n')
    writeFileSync(path.join(root, '.orcaignore'), 'orca-ignored/\n')

    const visibleFileCount = LARGE_TREE_FILE_COUNT - LARGE_TREE_IGNORED_FILE_COUNT - 3
    createFiles(root, 'src', visibleFileCount, 'ts')
    createFiles(root, 'data', LARGE_TREE_IGNORED_FILE_COUNT, 'bin')
    const lastIgnoredIndex = LARGE_TREE_IGNORED_FILE_COUNT - 1
    const lastIgnoredChunk =
      Math.floor(lastIgnoredIndex / FILES_PER_DIRECTORY) * FILES_PER_DIRECTORY
    const ignoredDirectory = `chunk-${String(lastIgnoredChunk).padStart(6, '0')}`
    const gitIgnoredTargetPath = `data/${ignoredDirectory}/sta-4354-gitignored-target.bin`
    renameSync(
      path.join(
        root,
        'data',
        ignoredDirectory,
        `${LONG_STEM}${String(lastIgnoredIndex).padStart(6, '0')}.bin`
      ),
      path.join(root, ...gitIgnoredTargetPath.split('/'))
    )
    const orcaIgnoredTargetPath = 'orca-ignored/sta-4354-orcaignore-target.ts'
    mkdirSync(path.join(root, 'orca-ignored'))
    closeSync(openSync(path.join(root, ...orcaIgnoredTargetPath.split('/')), 'w'))
    truncateSync(
      path.join(root, 'data', 'chunk-000000', `${LONG_STEM}000000.bin`),
      LARGE_TREE_NOMINAL_IGNORED_BYTES
    )

    execFileSync('git', ['add', '.gitignore', '.orcaignore'], { cwd: root, stdio: 'pipe' })
    execFileSync(
      'git',
      [
        '-c',
        'user.name=Orca E2E',
        '-c',
        'user.email=orca-e2e@example.invalid',
        'commit',
        '-m',
        'seed large-tree fixture'
      ],
      { cwd: root, stdio: 'pipe' }
    )
    return {
      root,
      gitIgnoredTargetPath,
      orcaIgnoredTargetPath,
      dispose: () => rmSync(root, { recursive: true, force: true })
    }
  } catch (error) {
    rmSync(root, { recursive: true, force: true })
    throw error
  }
}
