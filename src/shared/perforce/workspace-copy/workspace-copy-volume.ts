import { randomBytes } from 'node:crypto'
import { access, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { pathExists } from './workspace-copy-source'

/** Asked of the volume itself: a file made in lower case is looked up in upper case. */
async function isCaseSensitiveFolder(dir: string): Promise<boolean> {
  const probe = join(dir, `.orca-case-probe-${randomBytes(4).toString('hex')}`)
  await writeFile(probe, '')
  try {
    await access(join(dir, basename(probe).toUpperCase()))
    return false
  } catch {
    return true
  } finally {
    await rm(probe, { force: true })
  }
}

/**
 * What stops copies on a macOS volume besides cloning: `<root>.wt` on another volume than the
 * workspace (a clone cannot cross volumes), or a case-sensitive volume, since Perforce and Unity
 * projects here assume case-insensitive paths.
 */
export async function macVolumeProblems(root: string, copiesDir: string): Promise<string[]> {
  const target = (await pathExists(copiesDir)) ? copiesDir : dirname(copiesDir)
  const [targetStat, rootStat] = await Promise.all([stat(target), stat(root)])
  if (targetStat.dev !== rootStat.dev) {
    return [
      `${target} is on another volume than the workspace ${root}, so a copy would duplicate every byte. The workspace root must not be a mount point.`
    ]
  }
  if (await isCaseSensitiveFolder(target)) {
    return [
      `${target} is on a case-sensitive volume. Perforce and Unity projects assume case-insensitive paths, so keep the workspace on a case-insensitive APFS volume.`
    ]
  }
  return []
}
