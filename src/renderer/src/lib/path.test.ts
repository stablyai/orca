import { describe, expect, it } from 'vitest'
import { dirname, joinPath } from './path'

describe('dirname', () => {
  it('keeps the POSIX root when resolving a file in the filesystem root', () => {
    expect(dirname('/README.md')).toBe('/')
  })

  it('keeps the POSIX root when given the root path directly', () => {
    expect(dirname('/')).toBe('/')
  })

  it('keeps the Windows drive root when resolving a file in the drive root', () => {
    expect(dirname('C:\\README.md')).toBe('C:')
  })
})

describe('joinPath', () => {
  it('joins onto a Windows drive root returned by dirname', () => {
    expect(joinPath(dirname('C:\\README.md'), 'image.png')).toBe('C:/image.png')
  })
})
