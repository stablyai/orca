import { describe, expect, it } from 'vitest'
import {
  WEB_PRELOAD_MAX_ABORTABLE_REQUESTS,
  WEB_PRELOAD_MAX_REQUEST_TOKEN_BYTES,
  WebPreloadRequestOwners
} from './web-preload-request-owners'

describe('web preload request owners', () => {
  it('caps unique request tokens and recovers after release', () => {
    const owners = new WebPreloadRequestOwners()
    const first = owners.replace('request-0')
    for (let index = 1; index < WEB_PRELOAD_MAX_ABORTABLE_REQUESTS; index += 1) {
      owners.replace(`request-${index}`)
    }

    expect(() => owners.replace('overflow')).toThrow('capacity reached')
    owners.release('request-0', first)
    expect(() => owners.replace('recovered')).not.toThrow()
  })

  it('replaces same-token ownership without growing or letting stale cleanup win', () => {
    const owners = new WebPreloadRequestOwners()
    const first = owners.replace('stable')
    const replacement = owners.replace('stable')

    expect(first.signal.aborted).toBe(true)
    expect(owners.size()).toBe(1)
    owners.release('stable', first)
    expect(owners.size()).toBe(1)
    owners.release('stable', replacement)
    expect(owners.size()).toBe(0)
  })

  it('bounds multibyte request tokens before retaining them', () => {
    const owners = new WebPreloadRequestOwners()
    const exact = 'é'.repeat(WEB_PRELOAD_MAX_REQUEST_TOKEN_BYTES / 2)

    expect(() => owners.replace(exact)).not.toThrow()
    expect(() => owners.replace(`${exact}x`)).toThrow(
      `between 1 and ${WEB_PRELOAD_MAX_REQUEST_TOKEN_BYTES} UTF-8 bytes`
    )
  })

  it('aborts and releases every owner on teardown', () => {
    const owners = new WebPreloadRequestOwners()
    const first = owners.replace('first')
    const second = owners.replace('second')

    owners.abortAll()

    expect(first.signal.aborted).toBe(true)
    expect(second.signal.aborted).toBe(true)
    expect(owners.size()).toBe(0)
  })
})
