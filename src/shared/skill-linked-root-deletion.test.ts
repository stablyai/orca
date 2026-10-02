import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  describeSkillLinkedRootDeletion,
  findSkillLinkedRootDeletions,
  SKILL_LINKED_ROOT_DELETION_CODE
} from './skill-linked-root-deletion'
import {
  createLinkedRootHome,
  linkDanglingPlacement,
  linkDirectory,
  linkOrcaPlacement,
  linkProviderRoot,
  removeLinkedRootHomes,
  writeRealSkillDirectory
} from './skill-linked-root-deletion.test-fixture'

/**
 * Every case below runs on Windows as a junction, which is what Orca writes there and what
 * `isSymbolicLink()` reports on. Only the one true-`mklink /D` case is skipped, below.
 */
const WINDOWS = process.platform === 'win32'

afterEach(removeLinkedRootHomes)

function deletions(home: string, names: string[] = ['orca-cli']) {
  // An empty env keeps the host's own CLAUDE_CONFIG_DIR/GROK_HOME/HERMES_HOME out.
  return findSkillLinkedRootDeletions({ names, homeDir: home, env: {} })
}

describe('findSkillLinkedRootDeletions', () => {
  it('reports a real directory inside a linked skills root', async () => {
    const home = await createLinkedRootHome()
    const root = await linkProviderRoot(home, '.claude')
    await writeRealSkillDirectory(join(home, 'dotfiles', 'skills'), 'orca-cli')

    expect(await deletions(home)).toEqual([
      {
        name: 'orca-cli',
        rootPath: root,
        rootLabel: 'Claude home',
        destinationPath: join(root, 'orca-cli'),
        errorCategory: SKILL_LINKED_ROOT_DELETION_CODE
      }
    ])
  })

  /**
   * The case above runs as a junction on Windows; this one pins the other link a root can be
   * there, a true `mklink /D` directory symlink, which a user's dotfiles setup may have used.
   * Skipped on Windows because creating one needs elevation or Developer Mode — the only
   * shape in this file that does, and the reason the whole suite used to skip the platform.
   */
  it.skipIf(WINDOWS)('reports the same for a root that is a true directory symlink', async () => {
    const home = await createLinkedRootHome()
    const root = await linkProviderRoot(home, '.claude', 'dir')
    await writeRealSkillDirectory(join(home, 'dotfiles', 'skills'), 'orca-cli')

    expect((await deletions(home)).map((deletion) => deletion.destinationPath)).toEqual([
      join(root, 'orca-cli')
    ])
  })

  it('leaves the link Orca itself places in a linked root alone', async () => {
    const home = await createLinkedRootHome()
    await linkProviderRoot(home, '.claude')
    await linkOrcaPlacement(home, 'orca-cli')

    expect(await deletions(home)).toEqual([])
  })

  it('leaves a real directory in a root that is a real directory alone', async () => {
    const home = await createLinkedRootHome()
    await writeRealSkillDirectory(join(home, '.claude', 'skills'), 'orca-cli')

    expect(await deletions(home)).toEqual([])
  })

  it('leaves a dangling link inside a linked root alone', async () => {
    const home = await createLinkedRootHome()
    await linkProviderRoot(home, '.claude')
    await linkDanglingPlacement(home, 'orca-cli')

    expect(await deletions(home)).toEqual([])
  })

  it('judges each root on its own, so a linked one never implicates a real one', async () => {
    const home = await createLinkedRootHome()
    const cursorRoot = await linkProviderRoot(home, '.cursor')
    await writeRealSkillDirectory(join(home, 'dotfiles', 'skills'), 'orca-cli')
    // Same skill, same name, in a root that is an ordinary directory.
    await writeRealSkillDirectory(join(home, '.claude', 'skills'), 'orca-cli')

    expect((await deletions(home)).map((deletion) => deletion.rootPath)).toEqual([cursorRoot])
  })

  it('never reports the canonical .agents/skills root, whose content is the link target', async () => {
    const home = await createLinkedRootHome()
    await rm(join(home, '.agents'), { recursive: true })
    await mkdir(join(home, '.agents'), { recursive: true })
    await linkDirectory(join(home, 'dotfiles', 'skills'), join(home, '.agents', 'skills'))
    await writeRealSkillDirectory(join(home, 'dotfiles', 'skills'), 'orca-cli')

    expect(await deletions(home)).toEqual([])
  })

  it('reports only the names whose destination is at risk', async () => {
    const home = await createLinkedRootHome()
    await linkProviderRoot(home, '.claude')
    await writeRealSkillDirectory(join(home, 'dotfiles', 'skills'), 'orca-cli')
    await linkOrcaPlacement(home, 'orchestration')

    expect(
      (await deletions(home, ['orca-cli', 'orchestration'])).map((entry) => entry.name)
    ).toEqual(['orca-cli'])
  })

  it('judges the root an env var moved, not the default path nothing writes to', async () => {
    const home = await createLinkedRootHome()
    await mkdir(join(home, 'managed'), { recursive: true })
    await linkDirectory(join(home, 'dotfiles', 'skills'), join(home, 'managed', 'skills'))
    await writeRealSkillDirectory(join(home, 'dotfiles', 'skills'), 'orca-cli')

    expect(
      (
        await findSkillLinkedRootDeletions({
          names: ['orca-cli'],
          homeDir: home,
          env: { CLAUDE_CONFIG_DIR: join(home, 'managed') }
        })
      ).map((deletion) => deletion.rootPath)
    ).toEqual([join(home, 'managed', 'skills')])
  })

  it('names both paths and a remedy in the reason it hands to the user', async () => {
    const home = await createLinkedRootHome()
    const root = await linkProviderRoot(home, '.claude')
    await writeRealSkillDirectory(join(home, 'dotfiles', 'skills'), 'orca-cli')

    const [deletion] = await deletions(home)
    const reason = describeSkillLinkedRootDeletion(deletion)
    expect(reason).toContain(root)
    expect(reason).toContain(join(root, 'orca-cli'))
    expect(reason).toContain('.agents/skills')
  })
})
