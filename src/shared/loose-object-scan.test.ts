import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { scanLooseObjects } from './loose-object-scan'

const roots: string[] = []

function objectId(index: number): string {
  return index.toString(16).padStart(40, '0')
}

/** A `objects/` directory holding `count` loose objects across the fan-out. */
async function objectsDirectoryWith(count: number): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'orca-loose-objects-'))
  roots.push(root)
  const objects = join(root, 'objects')
  await mkdir(join(objects, 'pack'), { recursive: true })
  await mkdir(join(objects, 'info'), { recursive: true })
  for (let index = 0; index < count; index += 1) {
    const id = objectId(index)
    await mkdir(join(objects, id.slice(0, 2)), { recursive: true })
    await writeFile(join(objects, id.slice(0, 2), id.slice(2)), 'x')
  }
  return objects
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('scanLooseObjects', () => {
  it('counts and names every loose object under the fan-out', async () => {
    const objects = await objectsDirectoryWith(40)

    const scan = await scanLooseObjects(objects, 1000)

    expect(scan).toMatchObject({ count: 40, saturated: false })
    expect(scan.ids).toHaveLength(40)
    expect(new Set(scan.ids).size).toBe(40)
    expect(scan.ids).toContain(objectId(7))
    // Every id is a whole object name, not a path fragment.
    for (const id of scan.ids) {
      expect(id).toMatch(/^[0-9a-f]{40}$/)
    }
  })

  it('stops at the budget and says so', async () => {
    const objects = await objectsDirectoryWith(40)

    const scan = await scanLooseObjects(objects, 10)

    expect(scan).toMatchObject({ count: 10, saturated: true })
    expect(scan.ids).toHaveLength(10)
  })

  it('opens only the fan-out directories, never pack or info', async () => {
    const objects = await objectsDirectoryWith(4)
    // A pack directory full of files must contribute nothing at all.
    await writeFile(join(objects, 'pack', 'pack-abc.pack'), 'x')
    await writeFile(join(objects, 'pack', 'pack-abc.idx'), 'x')
    await writeFile(join(objects, 'info', 'alternates'), '/elsewhere/objects\n')
    await mkdir(join(objects, 'incoming-1234'), { recursive: true })
    await writeFile(join(objects, 'incoming-1234', objectId(99).slice(2)), 'x')

    await expect(scanLooseObjects(objects, 1000)).resolves.toMatchObject({
      count: 4,
      saturated: false
    })
  })

  it('never offers a half-written object to a pack', async () => {
    // Git renames `tmp_obj_*` into place once the object is complete, so a file
    // under a fan-out directory that is not an object id is not an object.
    const objects = await objectsDirectoryWith(2)
    await writeFile(join(objects, '00', 'tmp_obj_Ab12Cd'), 'x')
    await writeFile(join(objects, '00', 'not-an-object'), 'x')
    await mkdir(join(objects, '00', 'a-directory'), { recursive: true })

    const scan = await scanLooseObjects(objects, 1000)

    expect(scan.count).toBe(2)
    expect(scan.ids.some((id) => id.includes('tmp_obj'))).toBe(false)
  })

  it('counts SHA-256 object names too', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-loose-objects-sha256-'))
    roots.push(root)
    const objects = join(root, 'objects')
    const id = 'ab'.padEnd(64, 'c')
    await mkdir(join(objects, id.slice(0, 2)), { recursive: true })
    await writeFile(join(objects, id.slice(0, 2), id.slice(2)), 'x')

    await expect(scanLooseObjects(objects, 1000)).resolves.toMatchObject({
      count: 1,
      ids: [id]
    })
  })

  it('reports an absent object store as empty rather than throwing', async () => {
    await expect(
      scanLooseObjects(join(tmpdir(), 'orca-no-such-objects-dir'), 1000)
    ).resolves.toEqual({ count: 0, saturated: false, ids: [] })
  })

  it('reports what it saw as a floor when cancelled', async () => {
    const objects = await objectsDirectoryWith(40)
    const abort = new AbortController()
    abort.abort()

    await expect(scanLooseObjects(objects, 1000, abort.signal)).resolves.toMatchObject({
      saturated: true
    })
  })
})
