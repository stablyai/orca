import { describe, expect, it } from 'vitest'
import { githubAvatarIcon, sanitizeRepoIcon } from './repo-icon'

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
        src: 'data:image/png;base64,aGVsbG8=',
        source: 'upload'
      })
    ).toEqual({
      type: 'image',
      src: 'data:image/png;base64,aGVsbG8=',
      source: 'upload'
    })
    expect(
      sanitizeRepoIcon({
        type: 'image',
        src: 'data:image/png;base64,aGVsbG8=',
        source: 'file'
      })
    ).toEqual({
      type: 'image',
      src: 'data:image/png;base64,aGVsbG8=',
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
