import { afterEach, describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import {
  DOC_PREVIEW_PATH_AUTHORIZATION_ERROR,
  readAuthorizedDocPreviewFile
} from './doc-preview-file-access'

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
  it('reads the entry file without granting its containing directory', async () => {
    const fixture = await createFixture()

    await expect(
      readAuthorizedDocPreviewFile({
        boundaryPath: fixture.workspace,
        entryPath: fixture.entry,
        implicitRootPath: null,
        authorizedRootPaths: [],
        targetPath: fixture.entry,
        maxTextBytes: 1024,
        maxBinaryBytes: 1024
      })
    ).resolves.toEqual({ content: '<h1>entry</h1>', isBinary: false })
  })

  it('reads a file only after its canonical directory is authorized', async () => {
    const fixture = await createFixture()
    const asset = join(fixture.assets, 'app.js')
    await writeFile(asset, 'console.log(1)')
    const request = {
      boundaryPath: fixture.workspace,
      entryPath: fixture.entry,
      implicitRootPath: null,
      authorizedRootPaths: [] as string[],
      targetPath: asset,
      maxTextBytes: 1024,
      maxBinaryBytes: 1024
    }

    await expect(readAuthorizedDocPreviewFile(request)).rejects.toThrow(
      DOC_PREVIEW_PATH_AUTHORIZATION_ERROR
    )
    await expect(
      readAuthorizedDocPreviewFile({ ...request, authorizedRootPaths: [fixture.assets] })
    ).resolves.toEqual({ content: 'console.log(1)', isBinary: false })
  })

  it('rejects an authorized-directory symlink that resolves outside the workspace', async () => {
    const fixture = await createFixture()
    const outside = join(fixture.workspace, '..', 'outside')
    await mkdir(outside)
    await writeFile(join(outside, 'secret.txt'), 'secret')
    const linked = join(fixture.assets, 'linked')
    await symlink(outside, linked, process.platform === 'win32' ? 'junction' : 'dir')

    await expect(
      readAuthorizedDocPreviewFile({
        boundaryPath: fixture.workspace,
        entryPath: fixture.entry,
        implicitRootPath: fixture.docs,
        authorizedRootPaths: [fixture.assets],
        targetPath: join(linked, 'secret.txt'),
        maxTextBytes: 1024,
        maxBinaryBytes: 1024
      })
    ).rejects.toThrow(DOC_PREVIEW_PATH_AUTHORIZATION_ERROR)
  })

  it('does not let an implicit nested root canonicalize into whole-workspace authority', async () => {
    const fixture = await createFixture()
    const rootEntry = join(fixture.workspace, 'index.html')
    const secret = join(fixture.workspace, 'secret.txt')
    await writeFile(rootEntry, '<h1>entry</h1>')
    await writeFile(secret, 'secret')
    const linkedRoot = join(fixture.workspace, 'linked-root')
    await symlink(fixture.workspace, linkedRoot, process.platform === 'win32' ? 'junction' : 'dir')

    await expect(
      readAuthorizedDocPreviewFile({
        boundaryPath: fixture.workspace,
        entryPath: join(linkedRoot, 'index.html'),
        implicitRootPath: linkedRoot,
        authorizedRootPaths: [],
        targetPath: secret,
        maxTextBytes: 1024,
        maxBinaryBytes: 1024
      })
    ).rejects.toThrow(DOC_PREVIEW_PATH_AUTHORIZATION_ERROR)
  })

  // Why the skip: FIFOs are a POSIX shape; Windows has no mkfifo and no equivalent hazard here.
  it.skipIf(process.platform === 'win32')(
    'refuses a writer-less FIFO instead of blocking the open forever',
    async () => {
      const fixture = await createFixture()
      const fifo = join(fixture.assets, 'pipe')
      await promisify(execFile)('mkfifo', [fifo])

      // Without O_NONBLOCK this open never returns, so the timeout itself is the regression oracle.
      await expect(
        readAuthorizedDocPreviewFile({
          boundaryPath: fixture.workspace,
          entryPath: fixture.entry,
          implicitRootPath: null,
          authorizedRootPaths: [fixture.assets],
          targetPath: fifo,
          maxTextBytes: 1024,
          maxBinaryBytes: 1024
        })
      ).rejects.toThrow(DOC_PREVIEW_PATH_AUTHORIZATION_ERROR)
    }
  )

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
