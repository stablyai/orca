import { deflateSync } from 'node:zlib'
import { z } from 'zod'
import { test, expect } from './helpers/orca-app'
import { SIDEBAR_INPUTS_BUILD } from './helpers/sidebar-shadow'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { repoIconId } from '../../src/main/runtime/sidebar-inputs/repo-icon-data-urls'
import { readRasterImageDimensions } from '../../src/shared/raster-image-dimensions'

test.skip(
  !SIDEBAR_INPUTS_BUILD,
  'main publishes sidebar inputs only in an ORCA_SIDEBAR_INPUTS=main build'
)

const ReplySchema = z.object({
  icons: z.array(z.object({ id: z.string(), dataUrl: z.string().nullable() }))
})

function crc32(bytes: Buffer): number {
  let crc = ~0
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1
    }
  }
  return ~crc >>> 0
}

function pngChunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}

/** A real, decodable solid-colour RGB PNG. */
function solidPng(edge: number): string {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(edge, 0)
  header.writeUInt32BE(edge, 4)
  header[8] = 8
  header[9] = 2
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(edge * 3, 0x80)])
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(Buffer.concat(Array.from({ length: edge }, () => row)))),
    pngChunk('IEND', Buffer.alloc(0))
  ])
  return `data:image/png;base64,${png.toString('base64')}`
}

test('main re-encodes a 128 px repo upload as a 64 px PNG data URL', async ({ orcaPage }) => {
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  const icon = { type: 'image' as const, src: solidPng(128), source: 'upload' as const }

  await orcaPage.evaluate(async (repoIcon) => {
    const [repo] = await window.api.repos.list()
    await window.api.repos.update({ repoId: repo.id, updates: { repoIcon } })
  }, icon)

  const id = repoIconId(icon)
  expect(id).not.toBeNull()
  const response = await orcaPage.evaluate(
    (ids) => window.api.runtime.call({ method: 'sidebarInputs.repoIcons', params: { ids } }),
    [id, 'unknown']
  )
  if (!response.ok) {
    throw new Error('sidebarInputs.repoIcons failed')
  }
  const { icons } = ReplySchema.parse(response.result)

  expect(icons.map((entry) => entry.id)).toEqual([id, 'unknown'])
  expect(icons[1].dataUrl).toBeNull()
  const encoded = icons[0].dataUrl?.match(/^data:image\/png;base64,(.+)$/)?.[1]
  expect(encoded).toBeDefined()
  expect(readRasterImageDimensions(Buffer.from(encoded ?? '', 'base64'))).toEqual({
    width: 64,
    height: 64
  })
})
