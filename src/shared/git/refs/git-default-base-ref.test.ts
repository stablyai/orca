import { describe, expect, it } from 'vitest'
import {
  resolveDefaultBaseRefViaExec,
  resolveRemoteHeadBranchViaExec
} from './git-default-base-ref'

const refLine = (ref: string, symrefTarget = '') => `${ref}\0${symrefTarget}`

describe('resolveDefaultBaseRefViaExec', () => {
  it('prefers origin/HEAD when it points at a remote branch', async () => {
    const stdout = [refLine('refs/remotes/origin/HEAD', 'refs/remotes/origin/trunk')].join('\n')
    await expect(resolveDefaultBaseRefViaExec(async () => ({ stdout }))).resolves.toBe(
      'origin/trunk'
    )
  })

  it('falls back to the probe order', async () => {
    const stdout = [refLine('refs/heads/master'), refLine('refs/heads/main')].join('\n')
    await expect(resolveDefaultBaseRefViaExec(async () => ({ stdout }))).resolves.toBe('main')
  })

  it('returns null when no probe ref exists', async () => {
    await expect(
      resolveDefaultBaseRefViaExec(async () => ({ stdout: refLine('refs/heads/topic') }))
    ).resolves.toBeNull()
  })

  it('returns null when the lookup fails, and says so through onError', async () => {
    const failure = new Error('timed out')
    let reported: unknown
    await expect(
      resolveDefaultBaseRefViaExec(
        async () => {
          throw failure
        },
        (error) => {
          reported = error
        }
      )
    ).resolves.toBeNull()
    expect(reported).toBe(failure)
  })
})

describe('resolveRemoteHeadBranchViaExec', () => {
  it('reports only a HEAD symref under the named remote', async () => {
    const stdout = refLine('refs/remotes/upstream/HEAD', 'refs/remotes/upstream/devel')
    await expect(
      resolveRemoteHeadBranchViaExec(async () => ({ stdout }), 'upstream')
    ).resolves.toBe('devel')
  })
})
