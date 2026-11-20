// @vitest-environment happy-dom
// Perf contract: the Computer list asks each row's server account once per row, so that lookup must not
// scan the host list (a scan per row grows with the square of the hosts).
import { renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { publicRuntimeEnvironment } from '@/runtime/rpc/testing/paired-runtime-environment-test-fixture'
import { useBotCreateHost } from './bot-create-hosts'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('useBotCreateHost account lookup', () => {
  it('looks up every row without scanning the hosts', () => {
    useAppStore.setState({
      runtimeEnvironments: Array.from({ length: 100 }, (_, index) =>
        publicRuntimeEnvironment({ id: `server-${index}` })
      )
    })
    const { result } = renderHook(() => useBotCreateHost(false))
    const { hosts, otherAccountOf } = result.current
    expect(hosts.length).toBeGreaterThan(100)

    const find = vi.spyOn(Array.prototype, 'find')
    for (const host of hosts) {
      otherAccountOf(host.hostId)
    }
    expect(find).not.toHaveBeenCalled()
  })
})
