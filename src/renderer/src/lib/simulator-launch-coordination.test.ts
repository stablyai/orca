import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EmulatorStreamInfo } from '@/components/emulator-pane/emulator-pane-types'
import {
  consumePrelaunchedSimulatorSession,
  rememberPrelaunchedSimulatorSession,
  resetSimulatorLaunchCoordinationForTests
} from './simulator-launch-coordination'

function streamInfo(id: string): EmulatorStreamInfo {
  return {
    deviceUdid: id,
    streamUrl: `http://127.0.0.1:3100/${id}/stream.mjpeg`,
    wsUrl: `ws://127.0.0.1:3100/${id}/ws`
  }
}

describe('simulator-launch-coordination', () => {
  beforeEach(() => {
    resetSimulatorLaunchCoordinationForTests()
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
  })

  afterEach(() => {
    resetSimulatorLaunchCoordinationForTests()
    vi.useRealTimers()
  })

  it('measures handoff age independently of wall-clock corrections', () => {
    vi.setSystemTime(100_000)
    rememberPrelaunchedSimulatorSession('wt-rollback', streamInfo('device-rollback'))

    vi.setSystemTime(0)
    vi.advanceTimersByTime(30_000)

    expect(consumePrelaunchedSimulatorSession('wt-rollback')).toBeNull()

    rememberPrelaunchedSimulatorSession('wt-forward', streamInfo('device-forward'))
    vi.setSystemTime(1_000_000)

    expect(consumePrelaunchedSimulatorSession('wt-forward')).toMatchObject({
      deviceUdid: 'device-forward'
    })
  })

  it('treats a refreshed worktree key as the most recently remembered', () => {
    for (let index = 0; index < 16; index += 1) {
      rememberPrelaunchedSimulatorSession(`wt-${index}`, streamInfo(`device-${index}`))
    }

    rememberPrelaunchedSimulatorSession('wt-0', streamInfo('device-refreshed'))
    rememberPrelaunchedSimulatorSession('wt-16', streamInfo('device-16'))

    expect(consumePrelaunchedSimulatorSession('wt-1')).toBeNull()
    expect(consumePrelaunchedSimulatorSession('wt-0')).toMatchObject({
      deviceUdid: 'device-refreshed'
    })
    expect(consumePrelaunchedSimulatorSession('wt-16')).toMatchObject({
      deviceUdid: 'device-16'
    })
  })
})
