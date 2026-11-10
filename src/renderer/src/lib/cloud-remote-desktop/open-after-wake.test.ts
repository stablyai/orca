import { describe, expect, it, vi } from 'vitest'
import type { CloudRemoteDesktopResult } from '../../../../shared/hosted-sandbox/cloud-remote-desktop'
import {
  AFTER_WAKE_DEADLINE_MS,
  AFTER_WAKE_RETRY_MS,
  openDesktopAfterWake,
  type OpenAfterWakeDeps
} from './open-after-wake'

const opened: CloudRemoteDesktopResult = {
  ok: true,
  url: 'http://localhost:6080/vnc.html',
  localPort: 6080
}

function harness(answers: CloudRemoteDesktopResult[], overrides: Partial<OpenAfterWakeDeps> = {}) {
  let clock = 1_000
  const open = vi.fn(async () => answers.shift() ?? opened)
  const onAwake = vi.fn()
  const deps: OpenAfterWakeDeps = {
    wake: vi.fn(async () => 'awake' as const),
    wakeFailedSince: () => false,
    environmentId: () => 'env-1',
    open,
    onAwake,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms
    },
    ...overrides
  }
  return { deps, open, onAwake }
}

describe('openDesktopAfterWake', () => {
  it('opens the desktop once the sandbox is awake, with no second click', async () => {
    const { deps, open, onAwake } = harness([opened])
    await expect(openDesktopAfterWake(deps)).resolves.toEqual({
      kind: 'opened',
      environmentId: 'env-1',
      url: opened.url
    })
    expect(deps.wake).toHaveBeenCalledOnce()
    expect(onAwake).toHaveBeenCalledOnce()
    expect(open).toHaveBeenCalledWith('env-1')
  })

  it('reports a failed wake without asking for the desktop', async () => {
    const { deps, open, onAwake } = harness([], { wakeFailedSince: () => true })
    await expect(openDesktopAfterWake(deps)).resolves.toEqual({
      kind: 'failed',
      code: 'wake_failed'
    })
    expect(onAwake).not.toHaveBeenCalled()
    expect(open).not.toHaveBeenCalled()
  })

  it('passes the start time of this wake, so an older failed wake does not count', async () => {
    const wakeFailedSince = vi.fn(() => false)
    const { deps } = harness([opened], { wakeFailedSince })
    await openDesktopAfterWake(deps)
    expect(wakeFailedSince).toHaveBeenCalledWith(1_000)
  })

  it('stays quiet when Unarchive already showed why it failed', async () => {
    const { deps, open } = harness([], { wake: async () => 'reported' as const })
    await expect(openDesktopAfterWake(deps)).resolves.toEqual({ kind: 'cancelled' })
    expect(open).not.toHaveBeenCalled()
  })

  it('retries while a just-woken sandbox is still starting or its forward lags', async () => {
    const { deps, open } = harness([
      { ok: false, code: 'starting' },
      { ok: false, code: 'forward_failed' },
      opened
    ])
    await expect(openDesktopAfterWake(deps)).resolves.toMatchObject({ kind: 'opened' })
    expect(open).toHaveBeenCalledTimes(3)
  })

  it('treats a sandbox that stays asleep after the wake as a failed wake', async () => {
    const { deps, open } = harness([
      { ok: false, code: 'not_running' },
      { ok: false, code: 'not_running' }
    ])
    await expect(openDesktopAfterWake(deps)).resolves.toEqual({
      kind: 'failed',
      code: 'wake_failed'
    })
    expect(open).toHaveBeenCalledTimes(2)
  })

  it('returns other failures as they are', async () => {
    const { deps } = harness([{ ok: false, code: 'not_installed' }])
    await expect(openDesktopAfterWake(deps)).resolves.toEqual({
      kind: 'failed',
      code: 'not_installed'
    })
  })

  it('gives up with the last answer at the deadline', async () => {
    const attempts = Math.ceil(AFTER_WAKE_DEADLINE_MS / AFTER_WAKE_RETRY_MS) + 5
    const { deps, open } = harness(
      Array.from({ length: attempts }, () => ({ ok: false as const, code: 'starting' as const }))
    )
    await expect(openDesktopAfterWake(deps)).resolves.toEqual({ kind: 'failed', code: 'starting' })
    expect(open.mock.calls.length).toBeLessThanOrEqual(
      AFTER_WAKE_DEADLINE_MS / AFTER_WAKE_RETRY_MS + 1
    )
  })

  it('notices a wake that fails after its call returned', async () => {
    let failed = false
    const { deps, open } = harness([{ ok: false, code: 'starting' }], {
      wakeFailedSince: () => failed,
      sleep: async () => {
        failed = true
      }
    })
    await expect(openDesktopAfterWake(deps)).resolves.toEqual({
      kind: 'failed',
      code: 'wake_failed'
    })
    expect(open).toHaveBeenCalledOnce()
  })

  it('reports a wake the wake call said failed', async () => {
    const { deps, open } = harness([], { wake: async () => 'failed' as const })
    await expect(openDesktopAfterWake(deps)).resolves.toEqual({
      kind: 'failed',
      code: 'wake_failed'
    })
    expect(open).not.toHaveBeenCalled()
  })

  it('reports a wake that throws as a failed wake', async () => {
    const { deps, open } = harness([], { wake: () => Promise.reject(new Error('ipc')) })
    await expect(openDesktopAfterWake(deps)).resolves.toEqual({
      kind: 'failed',
      code: 'wake_failed'
    })
    expect(open).not.toHaveBeenCalled()
  })

  it('stops when the workspace went away during the wake', async () => {
    const { deps, open } = harness([], { environmentId: () => null })
    await expect(openDesktopAfterWake(deps)).resolves.toEqual({ kind: 'cancelled' })
    expect(open).not.toHaveBeenCalled()
  })
})
