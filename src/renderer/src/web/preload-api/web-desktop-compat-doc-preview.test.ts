// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DocPreviewGrantRequest } from '../../../../preload/api/document-preview/doc-preview-api'
import { createWebDocPreviewApi } from './web-desktop-compat-api'

const native = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('../tauri-native-host', () => ({
  isTauriNativeHost: () => true,
  invokeNative: native.invoke,
  listenNative: () => () => {}
}))

// Shape guard: the Rust commands mix struct params (mint/cache take a
// `request` struct) and bare params (revoke/authorize take plain strings).
// Wrapping a bare param in `args` is rejected live and the cleanup silently
// leaks, so every payload shape here is pinned against the Rust signature.
function grantRequest(): DocPreviewGrantRequest {
  return {
    owner: { kind: 'ssh', connectionId: 'conn-1' },
    requestBase: '/docs',
    root: '/docs',
    entryRelativePath: 'index.md',
    browserPageId: 'page-1'
  }
}

beforeEach(() => {
  native.invoke.mockReset()
})

describe('Tauri doc preview native shapes', () => {
  it('mints grants with the request struct', async () => {
    native.invoke.mockResolvedValue({ grantId: 'g-1', url: 'u' })
    const api = createWebDocPreviewApi()
    await expect(api.mintGrant(grantRequest())).resolves.toEqual({ grantId: 'g-1', url: 'u' })
    expect(native.invoke).toHaveBeenCalledWith('poc_doc_preview_mint_grant', {
      request: grantRequest()
    })
  })

  it('revokes grants with a bare grant id', async () => {
    native.invoke.mockResolvedValue(true)
    const api = createWebDocPreviewApi()
    await expect(api.revokeGrant('g-1')).resolves.toBe(true)
    expect(native.invoke).toHaveBeenCalledWith('poc_doc_preview_revoke_grant', {
      grantId: 'g-1'
    })
  })

  it('authorizes directories with bare ids', async () => {
    native.invoke.mockResolvedValue(true)
    const api = createWebDocPreviewApi()
    await expect(api.authorizeDirectory('g-1', 'assets')).resolves.toBe(true)
    expect(native.invoke).toHaveBeenCalledWith('poc_doc_preview_authorize_directory', {
      grantId: 'g-1',
      relativePath: 'assets'
    })
  })

  it('caches files with the request struct', async () => {
    native.invoke.mockResolvedValue(true)
    const api = createWebDocPreviewApi()
    const request = {
      grantId: 'g-1',
      relativePath: 'a.md',
      filePath: '/d/a.md',
      contentBase64: 'aGk='
    }
    await expect(api.cacheFile(request)).resolves.toBe(true)
    expect(native.invoke).toHaveBeenCalledWith('poc_doc_preview_cache_file', { request })
  })
})
