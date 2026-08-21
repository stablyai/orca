import { describe, expect, it } from 'vitest'
import { readBranchCompareHead } from './git-branch-compare-head'

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve
  })
  return { promise, resolve }
}

describe('readBranchCompareHead', () => {
  it('launches independent head reads before waiting for any result', async () => {
    const compareRef = deferred<string>()
    const baseRef = deferred<string>()
    const headOid = deferred<string>()
    const calls: string[] = []

    const pending = readBranchCompareHead({
      readCompareRef: () => {
        calls.push('compare-ref')
        return compareRef.promise
      },
      resolveBaseRef: () => {
        calls.push('base-probe')
        return baseRef.promise
      },
      readHeadOid: () => {
        calls.push('head-oid')
        return headOid.promise
      },
      readBaseOid: () => Promise.resolve('base-oid')
    })
    await Promise.resolve()

    expect(calls).toEqual(['compare-ref', 'base-probe', 'head-oid'])

    compareRef.resolve('feature')
    baseRef.resolve('refs/remotes/origin/main')
    headOid.resolve('head-oid')
    await expect(pending).resolves.toMatchObject({
      compareRef: 'feature',
      resolvedBaseRef: 'refs/remotes/origin/main',
      headOidResult: { ok: true, oid: 'head-oid' },
      baseOidResult: { ok: true, oid: 'base-oid' }
    })
  })
})
