import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const info = vi.fn()
vi.mock('sonner', () => ({ toast: { info: (...args: unknown[]) => info(...args) } }))

import {
  notifyIfRemoteUnsupported,
  resetRemoteUnsupportedToastForTest
} from './code-intel-remote-unsupported-toast'

describe('notifyIfRemoteUnsupported', () => {
  beforeEach(() => {
    info.mockClear()
    resetRemoteUnsupportedToastForTest()
  })
  afterEach(() => resetRemoteUnsupportedToastForTest())

  it('shows the toast once for a remote-runtime result', () => {
    notifyIfRemoteUnsupported({ status: 'unsupported', reason: 'remote-runtime' })
    notifyIfRemoteUnsupported({ status: 'unsupported', reason: 'remote-runtime' })
    expect(info).toHaveBeenCalledTimes(1)
  })

  it('does not toast for other unsupported reasons or ok/error results', () => {
    notifyIfRemoteUnsupported({ status: 'unsupported', reason: 'no-tsconfig' })
    notifyIfRemoteUnsupported({ status: 'unsupported', reason: 'not-ts' })
    notifyIfRemoteUnsupported({ status: 'ok', bufferVersion: 0, locations: [], truncated: false })
    notifyIfRemoteUnsupported({ status: 'error', code: 'x', message: 'y' })
    expect(info).not.toHaveBeenCalled()
  })
})
