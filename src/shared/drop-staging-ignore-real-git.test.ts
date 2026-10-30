import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { DROP_STAGING_GITIGNORE_CONTENT, DROP_STAGING_RELATIVE_DIR } from './drop-staging-ignore'
import { GitBinaryTestFixture } from './git-binary.test-fixture'

let fixture: GitBinaryTestFixture
let root = ''
let repo = ''

async function gitStatus(): Promise<string> {
  return (await fixture.exec(['status', '--porcelain', '--untracked-files=all'], repo)).stdout
}

async function dropFile(): Promise<void> {
  const drops = join(repo, ...DROP_STAGING_RELATIVE_DIR.split('/'))
  await mkdir(drops, { recursive: true })
  await writeFile(join(drops, '.gitignore'), DROP_STAGING_GITIGNORE_CONTENT)
  await writeFile(join(drops, 'shot.png'), 'png')
}

beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'orca-drop-staging-')))
  fixture = new GitBinaryTestFixture(root)
  await fixture.start()
})

afterAll(async () => {
  try {
    await fixture.stop()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

beforeEach(async () => {
  repo = await mkdtemp(join(root, 'repo-'))
  await fixture.exec(['init', '-q'], repo)
})

afterEach(async () => {
  await rm(repo, { recursive: true, force: true })
})

describe('drop staging ignore file with the real Git binary', () => {
  it('keeps dropped files and the ignore file itself out of git status', async () => {
    await dropFile()

    expect(await gitStatus()).toBe('')
  })

  // Older SSH builds wrote `.orca/.gitignore` with `!.gitignore`, which matches at any depth.
  it('keeps drops hidden under the legacy `.orca/.gitignore`', async () => {
    await dropFile()
    await writeFile(join(repo, '.orca', '.gitignore'), '*\n!.gitignore\n')

    expect(await gitStatus()).not.toContain(DROP_STAGING_RELATIVE_DIR)
  })
})
