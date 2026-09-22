import { describe, expect, it, vi } from 'vitest'
import {
  classifyTruncatedHookRequest,
  createHookTransportInterferenceTracker,
  describeHookTransportInterference,
  HookRequestTruncatedError,
  isHookRequestTruncatedError
} from './agent-hook-transport-interference'

describe('classifyTruncatedHookRequest', () => {
  it('reports truncation when fewer bytes arrived than Content-Length promised', () => {
    const error = classifyTruncatedHookRequest('4096', 512)
    expect(isHookRequestTruncatedError(error)).toBe(true)
    expect(error).toMatchObject({ bytesRead: 512, contentLength: 4096 })
  })

  it('reports truncation when the connection died before any body byte', () => {
    expect(classifyTruncatedHookRequest('4096', 0)).toBeInstanceOf(HookRequestTruncatedError)
  })

  it('stays silent for a complete body', () => {
    expect(classifyTruncatedHookRequest('512', 512)).toBeNull()
  })

  it('stays silent without a usable Content-Length', () => {
    // Why: chunked bodies and malformed headers prove nothing — reporting them would drown the signal.
    expect(classifyTruncatedHookRequest(undefined, 10)).toBeNull()
    expect(classifyTruncatedHookRequest('', 10)).toBeNull()
    expect(classifyTruncatedHookRequest('not-a-number', 10)).toBeNull()
  })

  it('reads the first value when the header arrives duplicated', () => {
    expect(classifyTruncatedHookRequest(['4096', '4096'], 12)).toBeInstanceOf(
      HookRequestTruncatedError
    )
  })
})

describe('createHookTransportInterferenceTracker', () => {
  const truncation = { source: 'claude', error: new HookRequestTruncatedError(10, 900) }

  it('stays quiet below the threshold so a single crashed writer is not an alarm', () => {
    const onThreshold = vi.fn()
    const tracker = createHookTransportInterferenceTracker(onThreshold, 3)
    tracker.record(truncation)
    tracker.record(truncation)
    expect(onThreshold).not.toHaveBeenCalled()
    expect(tracker.getCount()).toBe(2)
  })

  it('reports exactly once at the threshold and keeps counting after', () => {
    const onThreshold = vi.fn()
    const tracker = createHookTransportInterferenceTracker(onThreshold, 3)
    for (let i = 0; i < 6; i++) {
      tracker.record(truncation)
    }
    expect(onThreshold).toHaveBeenCalledTimes(1)
    expect(onThreshold).toHaveBeenCalledWith({
      count: 3,
      source: 'claude',
      bytesRead: 10,
      contentLength: 900
    })
    expect(tracker.getCount()).toBe(6)
  })

  it('re-arms after reset', () => {
    const onThreshold = vi.fn()
    const tracker = createHookTransportInterferenceTracker(onThreshold, 1)
    tracker.record(truncation)
    tracker.reset()
    tracker.record(truncation)
    expect(onThreshold).toHaveBeenCalledTimes(2)
  })
})

describe('describeHookTransportInterference', () => {
  it('names the cause and the consequence so the log line is actionable', () => {
    const message = describeHookTransportInterference({
      count: 3,
      source: 'codex',
      bytesRead: 10,
      contentLength: 900
    })
    expect(message).toContain('/hook/codex')
    expect(message).toContain('10/900 bytes')
    expect(message).toContain('security software')
    // Why: the client's own --max-time can truncate too; a single-cause message would misdiagnose a stall.
    expect(message).toContain('stalled past the hook client timeout')
  })

  it('omits the route when the truncation happened before it resolved', () => {
    const message = describeHookTransportInterference({
      count: 3,
      source: null,
      bytesRead: 0,
      contentLength: 900
    })
    expect(message).not.toContain('/hook/')
  })
})
