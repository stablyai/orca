import { existsSync } from 'node:fs'
import type * as FsPromises from 'node:fs/promises'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { planMacClone } from './workspace-copy-mac-clone'

const listing = vi.hoisted(() => {
  const hook: { after?: (dir: string) => Promise<void> } = {}
  return hook
})

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>()
  return {
    ...actual,
    readdir: async (dir: string, options: { withFileTypes: true }) => {
      const entries = await actual.readdir(dir, options)
      await listing.after?.(dir)
      return entries
    }
  }
})

let base: string

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'p4clone-'))
})

afterEach(async () => {
  listing.after = undefined
  await rm(base, { recursive: true, force: true })
})

describe('planMacClone', () => {
  it('lists only folders above an exclusion and hands everything else to cp whole', async () => {
    const source = join(base, 'ws')
    const game = join(source, 'Game')
    const library = join(game, 'Library')
    await mkdir(join(game, 'Temp'), { recursive: true })
    await mkdir(join(game, 'Assets', 'Temp'), { recursive: true })
    await mkdir(join(library, 'Artifacts'), { recursive: true })
    await mkdir(join(source, 'Tools'), { recursive: true })
    await writeFile(join(library, 'ArtifactDB'), 'db')
    await writeFile(join(library, 'ArtifactDB-lock'), 'lock')
    await writeFile(join(source, 'p4config.txt'), 'P4CLIENT=ws')

    const destination = join(base, 'ws.wt', 'one')
    const plan = await planMacClone(source, destination, {
      folders: [join(game, 'Temp')],
      files: [join(library, 'ArtifactDB-lock')]
    })

    expect(plan.folders).toEqual([
      [source, destination],
      [game, join(destination, 'Game')],
      [library, join(destination, 'Game', 'Library')]
    ])
    const sorted = plan.batches.map(({ sources, into }) => ({ sources: sources.toSorted(), into }))
    expect(sorted).toEqual([
      {
        sources: [join(source, 'Tools'), join(source, 'p4config.txt')].toSorted(),
        into: destination
      },
      { sources: [join(game, 'Assets')], into: join(destination, 'Game') },
      {
        sources: [join(library, 'ArtifactDB'), join(library, 'Artifacts')].toSorted(),
        into: join(destination, 'Game', 'Library')
      }
    ])
    expect(existsSync(join(destination, 'Game', 'Library'))).toBe(true)
  })

  it('refuses a listed folder that is swapped for a link before it is walked', async () => {
    const source = join(base, 'ws')
    const game = join(source, 'Game')
    const outside = join(base, 'outside')
    await mkdir(join(game, 'Temp'), { recursive: true })
    await mkdir(outside)
    await writeFile(join(outside, 'secret'), 'not part of the workspace')
    listing.after = async (dir) => {
      if (dir === source) {
        await rm(game, { recursive: true })
        await symlink(outside, game, 'junction')
      }
    }

    await expect(
      planMacClone(source, join(base, 'ws.wt', 'one'), {
        folders: [join(game, 'Temp')],
        files: []
      })
    ).rejects.toThrow('stopped being a folder')
  })
})
