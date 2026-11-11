import { afterEach, describe, expect, it } from 'vitest'

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { readAuthorizedDocPreviewFile } from './doc-preview-file-access'

const fixtureRoots: string[] = []

async function createFixture(): Promise<{
  workspace: string
  entry: string
  docs: string
  assets: string
}> {
  const fixture = await mkdtemp(join(tmpdir(), 'orca-doc-preview-access-'))
  fixtureRoots.push(fixture)
  const workspace = join(fixture, 'workspace')
  const docs = join(workspace, 'docs')
  const assets = join(workspace, 'assets')
  await Promise.all([mkdir(docs, { recursive: true }), mkdir(assets, { recursive: true })])
  const entry = join(docs, 'index.html')
  await writeFile(entry, '<h1>entry</h1>')
  return { workspace, entry, docs, assets }
}

afterEach(async () => {
  await Promise.all(
    fixtureRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  )
})

describe('readAuthorizedDocPreviewFile', () => {
  it('returns typed binary bytes and enforces the read cap', async () => {
    const fixture = await createFixture()
    const image = join(fixture.assets, 'logo.png')
    await writeFile(image, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    const request = {
      boundaryPath: fixture.workspace,
      entryPath: fixture.entry,
      implicitRootPath: fixture.docs,
      authorizedRootPaths: [fixture.assets],
      targetPath: image,
      maxTextBytes: 1024,
      maxBinaryBytes: 4
    }

    await expect(readAuthorizedDocPreviewFile(request)).resolves.toEqual({
      content: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64'),
      isBinary: true,
      mimeType: 'image/png'
    })
    await expect(readAuthorizedDocPreviewFile({ ...request, maxBinaryBytes: 3 })).rejects.toThrow(
      'file_too_large'
    )
  })
})
