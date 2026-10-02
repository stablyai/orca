import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Scratch homes shaped like orca#22897, with real links rather than a stubbed `lstat`:
 * the guard's whole answer is what `lstat` reports about a link, so a fake filesystem
 * would test the fake. Shared by the predicate's own suite and the update runner's.
 */

/**
 * The directory-link flavour Orca itself writes, per platform: a junction on Windows and a
 * directory symlink elsewhere (`skill-placement-reconciliation.ts` `createProviderAlias`).
 * A junction is not a weaker stand-in there — it is what production puts on disk, and it
 * needs no elevation, unlike the `symlink(..., 'dir')` these suites used to hardcode.
 */
const PLATFORM_DIRECTORY_LINK = process.platform === 'win32' ? 'junction' : 'dir'

/** One decision about link flavour for every fixture site, so no suite re-derives it. */
export function linkDirectory(
  target: string,
  path: string,
  type: 'dir' | 'junction' = PLATFORM_DIRECTORY_LINK
): Promise<void> {
  return symlink(target, path, type)
}

const homes: string[] = []

export async function createLinkedRootHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'orca-linked-root-'))
  homes.push(home)
  await mkdir(join(home, '.agents', 'skills', 'orca-cli'), { recursive: true })
  await writeFile(join(home, '.agents', 'skills', 'orca-cli', 'SKILL.md'), '# canonical\n')
  await mkdir(join(home, 'dotfiles', 'skills'), { recursive: true })
  return home
}

export async function removeLinkedRootHomes(): Promise<void> {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })))
}

export async function writeRealSkillDirectory(parent: string, name: string): Promise<string> {
  const path = join(parent, name)
  await mkdir(path, { recursive: true })
  await writeFile(join(path, 'SKILL.md'), `# ${name}\n`)
  return path
}

/** `<home>/<provider>/skills` linked at the dotfiles tree, the way #22897's reporter has it. */
export async function linkProviderRoot(
  home: string,
  provider: string,
  type?: 'dir' | 'junction'
): Promise<string> {
  await mkdir(join(home, provider), { recursive: true })
  await linkDirectory(join(home, 'dotfiles', 'skills'), join(home, provider, 'skills'), type)
  return join(home, provider, 'skills')
}

/** The directory link Orca places itself; docs/reference/agent-skill-provider-paths.md. */
export async function linkOrcaPlacement(home: string, name: string): Promise<void> {
  // The canonical copy a placement points at, so the link resolves the way a real one does.
  await mkdir(join(home, '.agents', 'skills', name), { recursive: true })
  const path = join(home, 'dotfiles', 'skills', name)
  // Junctions cannot be relative, so Windows gets the absolute one `createProviderAlias` writes.
  if (process.platform === 'win32') {
    await linkDirectory(join(home, '.agents', 'skills', name), path)
    return
  }
  await linkDirectory(join('..', '..', '.agents', 'skills', name), path)
}

/** A link whose target is gone: built by removing a real one, so a junction can be dangling too. */
export async function linkDanglingPlacement(home: string, name: string): Promise<void> {
  const target = join(home, 'gone')
  await mkdir(target, { recursive: true })
  await linkDirectory(target, join(home, 'dotfiles', 'skills', name))
  await rm(target, { recursive: true, force: true })
}
