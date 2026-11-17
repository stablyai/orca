import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { planMacClone } from './workspace-copy-mac-clone'

let base: string

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'p4clone-'))
})

afterEach(async () => {
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
})
