// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import * as eventBuilder from '../events/activity-event-builder'
import { useAllAgentPaneThreads } from './use-agent-pane-threads'

// Perf contract: React reads an external store's snapshot on every store write. When that read built the
// Activity events, a burst of writes in one task (status commit, generated title, tab titles; startup
// restore; a phone's bulk clear) built once per write instead of once per render.

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function buildsForWriteBurst(writes: number): number {
  const builds = vi.spyOn(eventBuilder, 'buildActivityEvents')
  renderHook(() => useAllAgentPaneThreads())
  builds.mockClear()
  act(() => {
    for (let index = 0; index < writes; index++) {
      useAppStore.setState({ acknowledgedAgentsByPaneKey: { [`tab-${index}:leaf`]: index } })
    }
  })
  const count = builds.mock.calls.length
  cleanup()
  builds.mockRestore()
  return count
}

it('a burst of Activity input writes in one task builds once, at N and 10N writes', () => {
  expect(buildsForWriteBurst(10)).toBe(1)
  expect(buildsForWriteBurst(100)).toBe(1)
})
