import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { WEB_CLIENT_FILES_FILENAME } from './bundled-web-client-manifest'
import { findBundledWebClientRoot } from './bundled-web-client-root'

const roots: string[] = []
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'orca-shared-web-'))
  roots.push(root)
  return root
}
function manifest(root: string, files: unknown) {
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, WEB_CLIENT_FILES_FILENAME), JSON.stringify(files))
}
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })))

describe('bundled web file manifest', () => {
  it('finds real shared renderer files from Electron and plain Node roots', () => {
    const root = fixture()
    const appRoot = join(root, 'app.asar')
    const unpacked = `${appRoot}.unpacked`
    const renderer = join(unpacked, 'out/renderer')
    mkdirSync(renderer, { recursive: true })
    writeFileSync(join(renderer, 'web-index.html'), 'web')
    expect(findBundledWebClientRoot(appRoot)).toBeUndefined()
    manifest(renderer, ['web-index.html'])
    expect(findBundledWebClientRoot(appRoot)).toBe(renderer)
    expect(findBundledWebClientRoot(unpacked)).toBe(renderer)
    expect(findBundledWebClientRoot(join(unpacked, 'out/main'))).toBe(renderer)
    const web = join(unpacked, 'out/web')
    mkdirSync(web)
    writeFileSync(join(web, 'web-index.html'), 'standalone')
    expect(findBundledWebClientRoot(unpacked)).toBe(web)
  })
})
