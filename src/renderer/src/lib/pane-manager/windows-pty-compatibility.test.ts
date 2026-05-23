import { describe, expect, it } from 'vitest'
import { buildWindowsPtyCompatibilityOptions } from './windows-pty-compatibility'

describe('buildWindowsPtyCompatibilityOptions', () => {
  it('returns ConPTY compatibility options for local Windows terminals', () => {
    expect(
      buildWindowsPtyCompatibilityOptions({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        connectionId: null,
        cwd: 'C:\\repo',
        shellOverride: null
      })
    ).toEqual({
      windowsPty: { backend: 'conpty' }
    })
  })

  it('skips compatibility options for SSH-backed Windows terminals', () => {
    expect(
      buildWindowsPtyCompatibilityOptions({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        connectionId: 'ssh-1',
        cwd: 'C:\\repo',
        shellOverride: null
      })
    ).toEqual({})
  })

  it('skips compatibility options for WSL cwd terminals', () => {
    expect(
      buildWindowsPtyCompatibilityOptions({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        connectionId: null,
        cwd: '\\\\wsl.localhost\\Ubuntu\\home\\me\\repo',
        shellOverride: null
      })
    ).toEqual({})
  })

  it('skips compatibility options when the shell override launches WSL', () => {
    expect(
      buildWindowsPtyCompatibilityOptions({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        connectionId: null,
        cwd: 'C:\\repo',
        shellOverride: 'C:\\Windows\\System32\\wsl.exe'
      })
    ).toEqual({})
  })

  it('returns no options outside Windows', () => {
    expect(
      buildWindowsPtyCompatibilityOptions({
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)',
        connectionId: null,
        cwd: '/repo',
        shellOverride: null
      })
    ).toEqual({})
  })
})
