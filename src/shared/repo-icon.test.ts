import { describe, expect, it, vi } from 'vitest'
import type * as ImageDataUriModule from './file-preview/image-data-uri'
import { githubAvatarIcon, sanitizeRepoIcon } from './repo-icon'

// Count leaf data-URI header decodes to measure repeated hydration cost.
const { dataUriValidations } = vi.hoisted(() => ({ dataUriValidations: { count: 0 } }))

vi.mock('./file-preview/image-data-uri', async (importOriginal) => {
  const actual = await importOriginal<typeof ImageDataUriModule>()
  return {
    ...actual,
    validateRasterImageDataUri: (dataUri: string) => {
      dataUriValidations.count += 1
      return actual.validateRasterImageDataUri(dataUri)
    }
  }
})

const WEBP_1X1_BASE64 = 'UklGRhoAAABXRUJQVlA4IA4AAAAwAQCdASoBAAEAAQIlSkwAAA=='

function pngBase64(width: number, height: number): string {
  const bytes = Buffer.alloc(24)
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes)
  bytes.writeUInt32BE(13, 8)
  bytes.write('IHDR', 12, 'ascii')
  bytes.writeUInt32BE(width, 16)
  bytes.writeUInt32BE(height, 20)
  return bytes.toString('base64')
}

describe('sanitizeRepoIcon', () => {
  it('rejects unsupported image urls and oversized payloads', () => {
    expect(
      sanitizeRepoIcon({
        type: 'image',
        src: 'javascript:alert(1)',
        source: 'favicon'
      })
    ).toBeUndefined()
    expect(
      sanitizeRepoIcon({
        type: 'image',
        src: `data:image/png;base64,${pngBase64(32_769, 1)}`,
        source: 'upload'
      })
    ).toBeUndefined()
    expect(
      sanitizeRepoIcon({
        type: 'image',
        src: `data:image/png;base64,${'a'.repeat(401 * 1024)}`,
        source: 'upload'
      })
    ).toBeUndefined()
    expect(
      sanitizeRepoIcon({
        type: 'image',
        src: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=',
        source: 'upload'
      })
    ).toBeUndefined()
    expect(
      sanitizeRepoIcon({
        type: 'image',
        src: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=',
        source: 'file'
      })
    ).toBeUndefined()
    expect(
      sanitizeRepoIcon({
        type: 'image',
        src: 'https://example.com/nested/icon.png',
        source: 'github'
      })
    ).toBeUndefined()
    expect(
      sanitizeRepoIcon({
        type: 'image',
        src: 'https://user@example.com/icon.png',
        source: 'github'
      })
    ).toBeUndefined()
  })

  it('builds hosted avatar URLs only from a valid host value', () => {
    expect(
      githubAvatarIcon({ owner: 'acme', repo: 'widgets', host: 'GitHub.Acme.Test:8443' })
    ).toMatchObject({ src: 'https://github.acme.test:8443/acme.png?size=64' })
    // HTTPS serialization strips default port 443; a valid GHES host must still qualify.
    expect(
      githubAvatarIcon({ owner: 'acme', repo: 'widgets', host: 'ghe.example:443' })
    ).toMatchObject({ src: 'https://ghe.example/acme.png?size=64' })
    expect(
      githubAvatarIcon({ owner: 'acme', repo: 'widgets', host: 'github.com@evil.example' })
    ).toMatchObject({ src: 'https://github.com/acme.png?size=64' })
  })
})

describe('repo icon source validation memo', () => {
  it('keeps the verdict specific to the icon source', () => {
    const src = `data:image/webp;base64,${WEBP_1X1_BASE64}`
    expect(sanitizeRepoIcon({ type: 'image', src, source: 'file' })).toEqual({
      type: 'image',
      src,
      source: 'file'
    })
    // WebP is a `file` icon only; sharing one cache across sources would accept it as an upload.
    expect(sanitizeRepoIcon({ type: 'image', src, source: 'upload' })).toBeUndefined()
  })
})
