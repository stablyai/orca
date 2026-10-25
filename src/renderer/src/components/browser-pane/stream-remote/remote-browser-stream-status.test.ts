import { describe, expect, it } from 'vitest'
import {
  canReconnectRemoteBrowserStream,
  isRemoteBrowserStreamBusy,
  REMOTE_BROWSER_STREAM_IDLE,
  REMOTE_BROWSER_STREAM_LIVE,
  REMOTE_BROWSER_STREAM_OPENING,
  remoteBrowserStreamNotice,
  remoteBrowserStreamRetrying,
  remoteBrowserStreamStopped,
  type RemoteBrowserStreamStatus
} from './remote-browser-stream-status'

const ALL: RemoteBrowserStreamStatus[] = [
  REMOTE_BROWSER_STREAM_IDLE,
  REMOTE_BROWSER_STREAM_OPENING,
  REMOTE_BROWSER_STREAM_LIVE,
  remoteBrowserStreamRetrying('Lost connection to the remote server.'),
  remoteBrowserStreamStopped('Lost connection to the remote server.')
]

describe('remote browser stream status', () => {
  // Reconnect lives inside the notice; failure states must always carry one.
  it('always carries a notice in the states that report a failure', () => {
    expect(remoteBrowserStreamNotice(remoteBrowserStreamStopped('gone'))).toBe('gone')
    expect(remoteBrowserStreamNotice(remoteBrowserStreamRetrying('dropped'))).toBe('dropped')
  })

  it('stays silent while retrying until an attempt has actually failed', () => {
    expect(remoteBrowserStreamNotice(remoteBrowserStreamRetrying(null))).toBeNull()
    expect(isRemoteBrowserStreamBusy(remoteBrowserStreamRetrying(null))).toBe(true)
    expect(canReconnectRemoteBrowserStream(remoteBrowserStreamRetrying(null))).toBe(false)
  })

  it('reports no notice while nothing has failed', () => {
    for (const status of [
      REMOTE_BROWSER_STREAM_IDLE,
      REMOTE_BROWSER_STREAM_OPENING,
      REMOTE_BROWSER_STREAM_LIVE
    ]) {
      expect(remoteBrowserStreamNotice(status)).toBeNull()
    }
  })

  it('offers reconnect only once automatic recovery is over', () => {
    expect(canReconnectRemoteBrowserStream(remoteBrowserStreamStopped('gone'))).toBe(true)
    for (const status of ALL.filter((candidate) => candidate.kind !== 'stopped')) {
      expect(canReconnectRemoteBrowserStream(status)).toBe(false)
    }
  })

  it('is never busy in a state the user is expected to act on', () => {
    expect(isRemoteBrowserStreamBusy(remoteBrowserStreamStopped('gone'))).toBe(false)
    expect(isRemoteBrowserStreamBusy(REMOTE_BROWSER_STREAM_LIVE)).toBe(false)
    expect(isRemoteBrowserStreamBusy(REMOTE_BROWSER_STREAM_IDLE)).toBe(false)
  })

  it('is busy exactly while recovery is in flight', () => {
    expect(isRemoteBrowserStreamBusy(REMOTE_BROWSER_STREAM_OPENING)).toBe(true)
    expect(isRemoteBrowserStreamBusy(remoteBrowserStreamRetrying('dropped'))).toBe(true)
  })

  it('never offers reconnect without a notice to render it in', () => {
    for (const status of ALL) {
      if (canReconnectRemoteBrowserStream(status)) {
        expect(remoteBrowserStreamNotice(status)).not.toBeNull()
        expect(isRemoteBrowserStreamBusy(status)).toBe(false)
      }
    }
  })
})
