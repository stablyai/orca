import { describe, expect, it } from 'vitest'
import { getNativeFileDropRejectionMessage } from './useGlobalFileDrop'

describe('getNativeFileDropRejectionMessage', () => {
  it('formats metadata-only rejection messages for oversized native drops', () => {
    expect(
      getNativeFileDropRejectionMessage({
        byteLength: 0,
        pathCount: 999,
        reason: 'too-many-paths',
        target: 'rejected'
      })
    ).toEqual({
      description: 'Drop 256 or fewer files at a time.',
      title: 'Drop contains too many files.'
    })

    const message = getNativeFileDropRejectionMessage({
      byteLength: 300_000,
      pathCount: 2,
      reason: 'paths-too-large',
      target: 'rejected'
    })
    expect(message).toEqual({
      description: 'Drop fewer files or use a shorter path list.',
      title: 'Drop path list is too large.'
    })
    expect(JSON.stringify(message)).not.toContain('secret')
  })

  it('explains drag-temp files main could not copy, using their shared reason', () => {
    const rejection = { byteLength: 0, reason: 'temp-copy-failed', target: 'rejected' } as const
    expect(
      getNativeFileDropRejectionMessage({
        ...rejection,
        pathCount: 1,
        commonReason: 'permission-denied'
      })
    ).toEqual({ description: 'Permission denied.', title: "Orca couldn't copy 1 dropped file." })
    expect(
      getNativeFileDropRejectionMessage({ ...rejection, pathCount: 2, commonReason: 'timed-out' })
    ).toEqual({
      description: 'Copying took too long. Try the drop again.',
      title: "Orca couldn't copy 2 dropped files."
    })
    expect(getNativeFileDropRejectionMessage({ ...rejection, pathCount: 2 }).description).toBe(
      'Try the drop again.'
    )
  })

  it('names the drop whose file items carried no readable path (#15782)', () => {
    expect(
      getNativeFileDropRejectionMessage({
        byteLength: 0,
        pathCount: 2,
        reason: 'unresolved-paths',
        target: 'rejected'
      })
    ).toEqual({
      description: 'Save them to disk first, then drop the saved files.',
      title: "Orca couldn't read a path for the dropped files."
    })
  })
})
