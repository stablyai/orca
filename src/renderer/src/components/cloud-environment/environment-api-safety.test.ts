import { describe, expect, it } from 'vitest'
import { sampleBuild } from './cloud-environment-fixture-data'
import { mergeBuildsByRecency, settledEnvironmentsApi } from './environment-api-safety'

describe('mergeBuildsByRecency', () => {
  it('keeps the further-along view of a build but takes `active` from the fetch', () => {
    const streamed = sampleBuild({ id: 'bld_1', status: 'succeeded', active: false })
    const stalePoll = sampleBuild({
      id: 'bld_1',
      status: 'running',
      snapshotStartedAt: null,
      finishedAt: null,
      active: true
    })
    const [merged] = mergeBuildsByRecency([streamed], [stalePoll])
    expect(merged.status).toBe('succeeded')
    expect(merged.active).toBe(true)
  })

  it('takes newer fetched builds, in fetch order', () => {
    const old = sampleBuild({ id: 'bld_1', status: 'running', finishedAt: null })
    const done = sampleBuild({ id: 'bld_1', status: 'failed' })
    const fresh = sampleBuild({ id: 'bld_2', number: 8 })
    expect(mergeBuildsByRecency([old], [fresh, done]).map((b) => [b.id, b.status])).toEqual([
      ['bld_2', 'succeeded'],
      ['bld_1', 'failed']
    ])
  })
})

describe('settledEnvironmentsApi', () => {
  it('turns a rejected call into an error result', async () => {
    const gone = (): Promise<never> => Promise.reject(new Error('ipc gone'))
    const api = settledEnvironmentsApi({
      list: gone,
      get: gone,
      create: gone,
      update: gone,
      startBuild: gone,
      cancelBuild: gone,
      activateBuild: gone
    })
    await expect(api.get('env_1')).resolves.toEqual({
      ok: false,
      error: { code: 'unavailable', message: 'ipc gone' }
    })
  })
})
