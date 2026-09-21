import { describe, expect, it, vi } from 'vitest'
import type * as ImageDataUriModule from './image-data-uri'
import { githubAvatarIcon, githubAvatarSlug, sanitizeRepoIcon } from './repo-icon'

// Why a module mock: `validateRasterImageDataUri` is the leaf that base64-decodes an inline icon's
// header, so counting its invocations is the direct measure of what re-hydrating a repo costs.
const { dataUriValidations } = vi.hoisted(() => ({ dataUriValidations: { count: 0 } }))

vi.mock('./image-data-uri', async (importOriginal) => {
  const actual = await importOriginal<typeof ImageDataUriModule>()
  return {
    ...actual,
    validateRasterImageDataUri: (dataUri: string) => {
      dataUriValidations.count += 1
      return actual.validateRasterImageDataUri(dataUri)
    }
  }
})

const PNG_1X1_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII='
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
  it('accepts lucide, emoji, and supported image icons', () => {
    expect(sanitizeRepoIcon({ type: 'lucide', name: 'Folder' })).toEqual({
      type: 'lucide',
      name: 'Folder'
    })
    expect(sanitizeRepoIcon({ type: 'emoji', emoji: '🚀' })).toEqual({
      type: 'emoji',
      emoji: '🚀'
    })
    expect(
      sanitizeRepoIcon({
        type: 'image',
        src: 'https://github.com/stablyai.png?size=64',
        source: 'github',
        label: 'stablyai/orca'
      })
    ).toEqual({
      type: 'image',
      src: 'https://github.com/stablyai.png?size=64',
      source: 'github',
      label: 'stablyai/orca'
    })
    expect(
      sanitizeRepoIcon({
        type: 'image',
        src: 'https://github.acme.test/stablyai.png?size=64',
        source: 'github',
        label: 'stablyai/orca'
      })
    ).toEqual({
      type: 'image',
      src: 'https://github.acme.test/stablyai.png?size=64',
      source: 'github',
      label: 'stablyai/orca'
    })
    expect(
      sanitizeRepoIcon({
        type: 'image',
        src: 'https://www.google.com/s2/favicons?domain=example.com&sz=64',
        source: 'favicon'
      })
    ).toEqual({
      type: 'image',
      src: 'https://www.google.com/s2/favicons?domain=example.com&sz=64',
      source: 'favicon'
    })
    expect(
      sanitizeRepoIcon({
        type: 'image',
        src: `data:image/png;base64,${PNG_1X1_BASE64}`,
        source: 'upload'
      })
    ).toEqual({
      type: 'image',
      src: `data:image/png;base64,${PNG_1X1_BASE64}`,
      source: 'upload'
    })
    expect(
      sanitizeRepoIcon({
        type: 'image',
        src: `data:image/png;base64,${PNG_1X1_BASE64}`,
        source: 'file'
      })
    ).toEqual({
      type: 'image',
      src: `data:image/png;base64,${PNG_1X1_BASE64}`,
      source: 'file'
    })
    expect(
      sanitizeRepoIcon({
        type: 'image',
        src: `data:image/webp;base64,${WEBP_1X1_BASE64}`,
        source: 'file'
      })
    ).toEqual({
      type: 'image',
      src: `data:image/webp;base64,${WEBP_1X1_BASE64}`,
      source: 'file'
    })
  })

  it('keeps null as an explicit reset', () => {
    expect(sanitizeRepoIcon(null)).toBeNull()
  })

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
    // Explicit default port 443 is canonical for an HTTPS host: accept it
    // (serialized without the port) rather than falling back to github.com.
    expect(
      githubAvatarIcon({ owner: 'acme', repo: 'widgets', host: 'ghe.example:443' })
    ).toMatchObject({ src: 'https://ghe.example/acme.png?size=64' })
    expect(
      githubAvatarIcon({ owner: 'acme', repo: 'widgets', host: 'github.com@evil.example' })
    ).toMatchObject({ src: 'https://github.com/acme.png?size=64' })
  })
})

describe('githubAvatarSlug', () => {
  const upstream = { owner: 'upstream-org', repo: 'rocket' }

  it('keeps the upstream owner for a same-name fork, case-insensitively', () => {
    expect(githubAvatarSlug({ owner: 'acme', repo: 'rocket' }, upstream)).toEqual(upstream)
    expect(githubAvatarSlug({ owner: 'acme', repo: 'RocKet' }, upstream)).toEqual(upstream)
  })

  it('keeps the fork own owner once it has been renamed', () => {
    const origin = { owner: 'acme', repo: 'rocket-pro' }
    expect(githubAvatarSlug(origin, upstream)).toEqual(origin)
  })

  it('falls back to whichever identity is known', () => {
    const origin = { owner: 'acme', repo: 'rocket-pro' }
    expect(githubAvatarSlug(origin, null)).toEqual(origin)
    expect(githubAvatarSlug(null, upstream)).toEqual(upstream)
    expect(githubAvatarSlug(null, undefined)).toBeNull()
  })
})

describe('repo icon source validation memo', () => {
  const HYDRATIONS = 25

  function uploadIcon(width: number): { type: 'image'; src: string; source: 'upload' } {
    return { type: 'image', src: `data:image/png;base64,${pngBase64(width, 1)}`, source: 'upload' }
  }

  it('validates each distinct icon src once across repeated hydrations', () => {
    const icons = [uploadIcon(2), uploadIcon(3), uploadIcon(4)]
    // Warm the memo the way the first hydration would, then measure steady state.
    for (const icon of icons) {
      sanitizeRepoIcon(icon)
    }
    dataUriValidations.count = 0

    for (let hydration = 0; hydration < HYDRATIONS; hydration += 1) {
      for (const icon of icons) {
        expect(sanitizeRepoIcon(icon)).toEqual(icon)
      }
    }

    // Unmemoized this is HYDRATIONS x icons full base64 header decodes; memoized an unchanged
    // persisted icon costs nothing.
    expect(dataUriValidations.count).toBe(0)
  })

  it('re-validates as soon as the src changes', () => {
    dataUriValidations.count = 0
    expect(sanitizeRepoIcon(uploadIcon(11))).toEqual(uploadIcon(11))
    expect(sanitizeRepoIcon(uploadIcon(12))).toEqual(uploadIcon(12))
    expect(dataUriValidations.count).toBe(2)
  })

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

  // Guard for the removed cap: the memo hangs off the persisted icon object, so it holds a verdict
  // for every live icon no matter how many there are. A fixed-size map would evict the earliest
  // entries here and re-decode them on the next hydration.
  it('keeps a verdict for every live icon, however many repos have one', () => {
    const LIVE_ICONS = 200
    const icons = Array.from({ length: LIVE_ICONS }, (_, index) => uploadIcon(1000 + index))
    for (const icon of icons) {
      sanitizeRepoIcon(icon)
    }
    dataUriValidations.count = 0

    for (const icon of icons) {
      expect(sanitizeRepoIcon(icon)).toEqual(icon)
    }

    expect(dataUriValidations.count).toBe(0)
  })

  // Guard for the hazard object keying introduces: the stored src/source are re-checked on a hit,
  // so a persisted icon edited in place can never be served its previous verdict.
  it('re-validates an icon object whose src or source is mutated in place', () => {
    const icon = { type: 'image', src: `data:image/png;base64,${pngBase64(7, 1)}`, source: 'file' }
    expect(sanitizeRepoIcon(icon)).toEqual(icon)

    icon.src = `data:image/png;base64,${pngBase64(8, 1)}`
    dataUriValidations.count = 0
    expect(sanitizeRepoIcon(icon)).toEqual(icon)
    expect(dataUriValidations.count).toBe(1)

    // WebP is a `file` icon but not an `upload` icon, so the same object must flip verdicts.
    icon.src = `data:image/webp;base64,${WEBP_1X1_BASE64}`
    expect(sanitizeRepoIcon(icon)).toEqual(icon)
    icon.source = 'upload'
    expect(sanitizeRepoIcon(icon)).toBeUndefined()
  })
})
