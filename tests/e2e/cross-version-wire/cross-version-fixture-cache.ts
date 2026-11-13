import { createHash, randomUUID } from 'node:crypto'
import { mkdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export async function prepareCrossVersionFixtureCache(repoRoot: string): Promise<string> {
  const key = createHash('sha256').update(repoRoot).digest('hex').slice(0, 16)
  const root = join(tmpdir(), 'orca-cross-version-checkouts', key)
  await mkdir(root, { recursive: true })
  const dependencies = join(repoRoot, 'node_modules')
  const linkedDependencies = join(root, 'node_modules')
  try {
    await symlink(
      dependencies,
      linkedDependencies,
      process.platform === 'win32' ? 'junction' : 'dir'
    )
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') {
      throw error
    }
    if ((await realpath(linkedDependencies)) !== (await realpath(dependencies))) {
      throw new Error('Cross-version fixture cache has a different dependency installation')
    }
  }
  const config = join(root, 'tsconfig.json')
  const staged = `${config}.${randomUUID()}.tmp`
  try {
    await writeFile(
      staged,
      JSON.stringify({ extends: join(repoRoot, 'config', 'tsconfig.vitest-transform.json') })
    )
    await rename(staged, config)
  } finally {
    await rm(staged, { force: true })
  }
  return root
}
