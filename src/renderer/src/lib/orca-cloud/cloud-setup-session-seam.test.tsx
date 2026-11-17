// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { CloudSetupStep } from '@/components/new-workspace/run-on/cloud-start-model'
import {
  getCloudSetupSessionSnapshot,
  notifyCloudSetupSessionChanged,
  setCloudSetupSessionSource,
  useCloudSetupSession,
  type CloudSetupSessionSnapshot
} from './cloud-setup-session-seam'

const planActive: CloudSetupStep[] = [
  { id: 'account', state: 'done' },
  { id: 'plan', state: 'active' }
]
const planDone: CloudSetupStep[] = [
  { id: 'account', state: 'done' },
  { id: 'plan', state: 'done' }
]

/** A poller stand-in: the source builds a new object on every read, like the real one. */
function installPoller(): { set: (next: CloudSetupSessionSnapshot | null) => void } {
  let latest: CloudSetupSessionSnapshot | null = null
  setCloudSetupSessionSource((sessionId) =>
    sessionId === 'cs_test' && latest ? { ...latest, steps: [...latest.steps] } : null
  )
  return {
    set: (next) => {
      latest = next
      notifyCloudSetupSessionChanged()
    }
  }
}

afterEach(() => {
  cleanup()
  setCloudSetupSessionSource(null)
})

describe('getCloudSetupSessionSnapshot', () => {
  it('returns the same object until the next change, then the new snapshot', () => {
    const poller = installPoller()
    poller.set({ steps: planActive, finished: false })
    const first = getCloudSetupSessionSnapshot('cs_test')
    expect(getCloudSetupSessionSnapshot('cs_test')).toBe(first)
    poller.set({ steps: planDone, finished: true })
    expect(getCloudSetupSessionSnapshot('cs_test')).toEqual({ steps: planDone, finished: true })
  })

  it('is null without a session id or a source', () => {
    expect(getCloudSetupSessionSnapshot(null)).toBeNull()
    expect(getCloudSetupSessionSnapshot('cs_test')).toBeNull()
  })
})

describe('useCloudSetupSession', () => {
  it('re-renders with each poll, starting from no snapshot yet', () => {
    const poller = installPoller()
    const { result } = renderHook(() => useCloudSetupSession('cs_test'))
    expect(result.current).toBeNull()
    act(() => poller.set({ steps: planActive, finished: false }))
    expect(result.current?.steps).toEqual(planActive)
    act(() => poller.set({ steps: planDone, finished: true }))
    expect(result.current).toEqual({ steps: planDone, finished: true })
  })
})
