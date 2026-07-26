import { describe, expect, it } from 'vitest'
import { getUtf8ByteLength } from './utf8-byte-limits'
import {
  admitSshConnectionState,
  admitSshDetectedPorts,
  SSH_CONNECTION_ERROR_MAX_UTF8_BYTES,
  SSH_DETECTED_PORTS_MAX_ENTRIES,
  SSH_DETECTED_PORT_ADVERTISED_URL_MAX_UTF8_BYTES,
  SSH_DETECTED_PORT_PROCESS_NAME_MAX_UTF8_BYTES,
  SSH_RETAINED_IDENTIFIER_MAX_UTF8_BYTES
} from './ssh-retained-payload-admission'

describe('SSH retained payload admission', () => {
  it('keeps ordinary connection state while stripping unknown payload fields', () => {
    const admitted = admitSshConnectionState(
      {
        targetId: 'ssh-a',
        status: 'connected',
        error: null,
        reconnectAttempt: 2,
        connectionGeneration: 3,
        supportsFolderDownload: true,
        remotePlatform: 'linux',
        unexpected: 'x'.repeat(1024)
      },
      'ssh-a'
    )

    expect(admitted).toEqual({
      targetId: 'ssh-a',
      status: 'connected',
      error: null,
      reconnectAttempt: 2,
      connectionGeneration: 3,
      supportsFolderDownload: true,
      remotePlatform: 'linux'
    })
  })

  it('caps connection errors without splitting a UTF-8 code point', () => {
    const admitted = admitSshConnectionState(
      {
        targetId: 'ssh-a',
        status: 'error',
        error: `${'x'.repeat(SSH_CONNECTION_ERROR_MAX_UTF8_BYTES - 1)}🙂tail`,
        reconnectAttempt: 0
      },
      'ssh-a'
    )

    expect(admitted).not.toBeNull()
    expect(getUtf8ByteLength(admitted?.error ?? '')).toBeLessThanOrEqual(
      SSH_CONNECTION_ERROR_MAX_UTF8_BYTES
    )
    expect(admitted?.error?.endsWith('\ud83d')).toBe(false)
  })

  it('rejects mismatched and oversized target identifiers', () => {
    const state = {
      targetId: 'ssh-a',
      status: 'connected',
      error: null,
      reconnectAttempt: 0
    }

    expect(admitSshConnectionState(state, 'ssh-b')).toBeNull()
    expect(
      admitSshConnectionState(
        { ...state, targetId: 'x'.repeat(SSH_RETAINED_IDENTIFIER_MAX_UTF8_BYTES + 1) },
        'x'.repeat(SSH_RETAINED_IDENTIFIER_MAX_UTF8_BYTES + 1)
      )
    ).toBeNull()
  })

  it('caps port rows and their retained strings', () => {
    const rows = Array.from({ length: SSH_DETECTED_PORTS_MAX_ENTRIES + 10 }, (_, index) => ({
      port: 1000 + index,
      host: '127.0.0.1',
      pid: index + 1,
      processName: '🙂'.repeat(SSH_DETECTED_PORT_PROCESS_NAME_MAX_UTF8_BYTES),
      advertisedUrl: `https://example.test/${'x'.repeat(
        SSH_DETECTED_PORT_ADVERTISED_URL_MAX_UTF8_BYTES
      )}`,
      unexpected: 'retained only without admission'
    }))

    const admitted = admitSshDetectedPorts(rows)

    expect(admitted).toHaveLength(SSH_DETECTED_PORTS_MAX_ENTRIES)
    expect(getUtf8ByteLength(admitted[0].processName ?? '')).toBeLessThanOrEqual(
      SSH_DETECTED_PORT_PROCESS_NAME_MAX_UTF8_BYTES
    )
    expect(admitted[0].advertisedUrl).toBeUndefined()
    expect(admitted[0]).not.toHaveProperty('unexpected')
  })

  it('drops malformed rows instead of retaining their payloads', () => {
    expect(
      admitSshDetectedPorts([
        { port: 0, host: '127.0.0.1' },
        { port: 3000, host: '' },
        { port: 3001, host: '127.0.0.1', processName: 'node' }
      ])
    ).toEqual([{ port: 3001, host: '127.0.0.1', processName: 'node' }])
  })
})
