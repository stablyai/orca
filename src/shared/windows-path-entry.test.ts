import { describe, expect, it } from 'vitest'
import { normalizeSingleWindowsPathEntry } from './windows-path-entry'

const validPaths = [
  'C:\\fnm',
  'C:/fnm',
  'C:\\Program Files\\fnm data',
  'C:\\用户\\fnm-λ',
  '\\\\server\\share\\fnm',
  '//server/share/fnm',
  '\\\\.\\Volume{01234567-89ab-cdef-0123-456789abcdef}\\fnm'
]

const invalidPaths = [
  undefined,
  '',
  'relative\\fnm',
  '\\root-relative\\fnm',
  '\\\\server',
  'C:\\fnm;',
  'C:\\fnm\\CON',
  'C:\\con\\fnm',
  'C:\\fnm\\NUL.txt',
  'C:\\fnm\\prn.log',
  'C:\\fnm\\AUX',
  'C:\\fnm\\COM1',
  'C:\\fnm\\LPT9.log',
  '\\\\.\\pipe\\orca-fnm',
  '\\\\?\\pipe\\orca-fnm',
  '\\\\?\\C:\\very long\\fnm',
  '\\\\?\\UNC\\server\\share\\fnm',
  '\\\\?\\Volume{01234567-89ab-cdef-0123-456789abcdef}\\fnm',
  '\\\\?\\GLOBALROOT\\Device\\HarddiskVolume1\\fnm',
  '\\\\.\\PhysicalDrive0',
  '\\\\server\\pipe\\orca-fnm',
  '\\\\?\\UNC\\server\\pipe\\orca-fnm',
  '\\\\?\\UNC\\server',
  '\\\\?\\UNC/server/share',
  '\\\\?\\C:\\fnm/aliases',
  ' C:\\fnm',
  'C:\\fnm '
]

describe('normalizeSingleWindowsPathEntry', () => {
  it.each(validPaths)('accepts filesystem path %s', (path) => {
    expect(normalizeSingleWindowsPathEntry(path)).toBe(path)
  })

  it.each(invalidPaths)('rejects unsafe path %s', (path) => {
    expect(normalizeSingleWindowsPathEntry(path)).toBeNull()
  })
})
