import { describe, expect, it } from 'vitest'
import { watchedDirectoryDeletionCheck } from './windows-deleted-directory-watch'

describe('watchedDirectoryDeletionCheck', () => {
  it('matches only the namespaced watch path libuv reports for a deleted Windows directory', () => {
    const isDeleted = watchedDirectoryDeletionCheck('C:\\repo\\.git', 'win32')

    expect(isDeleted('rename', '\\\\?\\C:\\repo\\.git')).toBe(true)
    expect(isDeleted('rename', '.git')).toBe(false)
    expect(isDeleted('rename', 'HEAD')).toBe(false)
    expect(isDeleted('change', '\\\\?\\C:\\repo\\.git')).toBe(false)
    expect(isDeleted('rename', null)).toBe(false)
  })

  it('matches UNC watch paths', () => {
    const isDeleted = watchedDirectoryDeletionCheck('\\\\server\\share\\repo', 'win32')

    expect(isDeleted('rename', '\\\\?\\UNC\\server\\share\\repo')).toBe(true)
  })

  it('never matches off Windows', () => {
    const isDeleted = watchedDirectoryDeletionCheck('/repo/.git', 'linux')

    expect(isDeleted('rename', '/repo/.git')).toBe(false)
  })
})
