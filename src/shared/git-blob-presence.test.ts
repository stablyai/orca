import { describe, expect, it, vi } from 'vitest'
import { probeGitBlobPresence } from './git-blob-presence'

describe('Git blob presence independently of LFS filters', () => {
  it('proves absence only from a successful empty index listing', async () => {
    const gitBuffer = vi.fn().mockResolvedValue(Buffer.alloc(0))
    expect(await probeGitBlobPresence(gitBuffer, 'assets/image[1].png')).toBe(false)
    expect(gitBuffer).toHaveBeenCalledWith([
      'ls-files',
      '--stage',
      '-z',
      '--',
      ':(literal)assets/image[1].png'
    ])
  })

  it('keeps a tracked image present when its configured filter fails', async () => {
    const gitBuffer = vi
      .fn()
      .mockResolvedValue(Buffer.from(`100644 ${'a'.repeat(40)} 0\timage.png\0`))
    expect(await probeGitBlobPresence(gitBuffer, 'image.png')).toBe(true)
  })

  it('uses the historical tree rather than current index or attributes', async () => {
    const gitBuffer = vi.fn().mockResolvedValue(Buffer.from('100644 blob synthetic\timage.png\0'))
    expect(await probeGitBlobPresence(gitBuffer, 'image.png', 'HEAD~1')).toBe(true)
    expect(gitBuffer).toHaveBeenCalledWith(['ls-tree', '-z', '--', 'HEAD~1', ':(literal)image.png'])
  })

  it('does not turn a failed presence probe into a proven deletion', async () => {
    const gitBuffer = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error('Synthetic read failure'), { code: 128 }))
    expect(await probeGitBlobPresence(gitBuffer, 'image.png')).toBeNull()
  })

  it('distinguishes unmerged stages from the stage zero blob', async () => {
    const gitBuffer = vi
      .fn()
      .mockResolvedValue(
        Buffer.from(
          [1, 2, 3].map((stage) => `100644 ${'a'.repeat(40)} ${stage}\timage.png\0`).join('')
        )
      )
    expect(await probeGitBlobPresence(gitBuffer, 'image.png')).toBe('unmerged')
  })

  it('does not infer presence from malformed stage metadata', async () => {
    expect(await probeGitBlobPresence(async () => Buffer.from('invalid\0'), 'image.png')).toBeNull()
  })
})
