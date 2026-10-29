import { afterEach, describe, expect, it, vi } from 'vitest'
import { formatClipboardFilePath } from './clipboard-file-path'
import { resetRendererAppPlatformCacheForTests } from './renderer-app-platform'
import type { LocalPathOpenOwner } from './local-path-open-guard'

function stubClient(platform: NodeJS.Platform, webClient = false): void {
  resetRendererAppPlatformCacheForTests()
  vi.stubGlobal('window', {
    api: { platform: { get: () => ({ platform }) } },
    ...(webClient ? { __ORCA_WEB_CLIENT__: true } : {})
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
  resetRendererAppPlatformCacheForTests()
})

describe('formatClipboardFilePath', () => {
  it.each([
    ['C:/repo/a space/é.txt', 'C:\\repo\\a space\\é.txt'],
    ['D:\\repo/mixed\\b.txt', 'D:\\repo\\mixed\\b.txt'],
    ['//server/share/b.txt', '\\\\server\\share\\b.txt']
  ])('uses backslashes for local Windows path %s', (path, expected) => {
    stubClient('win32')
    expect(formatClipboardFilePath(path, 'local')).toBe(expected)
  })

  it.each<[string, NodeJS.Platform, LocalPathOpenOwner, string, boolean?]>([
    ['SSH owner', 'win32', 'ssh:box', 'C:/repo/b.txt'],
    ['runtime owner', 'win32', 'runtime:env-1', 'C:/repo/b.txt'],
    ['unresolved owner', 'win32', 'unresolved', 'C:/repo/b.txt'],
    ['macOS client', 'darwin', 'local', 'C:/repo/b.txt'],
    ['Linux client', 'linux', 'local', '/repo/b.txt'],
    ['URL', 'win32', 'local', 'https://example.com/C:/b.txt'],
    ['relative path', 'win32', 'local', 'src/b.txt'],
    ['paired web client', 'win32', 'local', 'C:/repo/b.txt', true]
  ])('leaves the path unchanged for a %s', (_case, platform, owner, path, webClient) => {
    stubClient(platform, webClient)
    expect(formatClipboardFilePath(path, owner)).toBe(path)
  })
})
