import { expect, it } from 'vitest'
import {
  normalizeBrowserDownloadFilename,
  normalizeIncomingDownloadFilename
} from './browser-download-filename'

it('escapes Windows device names even when spaces precede the extension', () => {
  for (const name of ['NUL .txt', 'COM1 .log', 'con  .tar.gz', 'NUL.txt', 'aux']) {
    expect(normalizeBrowserDownloadFilename(name, 'win32')).toBe(`_${name}`)
    expect(normalizeIncomingDownloadFilename(name, 'win32')).toBe(`_${name}`)
  }
  expect(normalizeBrowserDownloadFilename('NUL .txt', 'linux')).toBe('NUL .txt')
  expect(normalizeBrowserDownloadFilename('nullable .txt', 'win32')).toBe('nullable .txt')
})
