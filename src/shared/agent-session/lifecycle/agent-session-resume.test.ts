import { describe, expect, it } from 'vitest'
import {
  extractAgentProviderSession,
  normalizeAgentProviderSession
} from './agent-session-resume'

describe('hermes provider session profile', () => {
  it('keeps the profile a hook reports with its session id', () => {
    expect(
      extractAgentProviderSession('hermes', { session_id: 'abc-123', hermes_profile: 'work' })
    ).toEqual({ key: 'session_id', id: 'abc-123', hermesProfile: 'work' })
  })

  it('keeps a profile-less hook unnamed', () => {
    expect(extractAgentProviderSession('hermes', { session_id: 'abc-123' })).toEqual({
      key: 'session_id',
      id: 'abc-123'
    })
  })

  it('drops names that never name a --profile argument', () => {
    for (const profile of ['default', 'custom', 'Work', 'a;b']) {
      expect(
        extractAgentProviderSession('hermes', { session_id: 'abc-123', hermes_profile: profile })
      ).toEqual({ key: 'session_id', id: 'abc-123' })
    }
  })

  it('persists only a validated profile through normalization', () => {
    expect(
      normalizeAgentProviderSession({
        key: 'session_id',
        id: 'abc-123',
        hermesProfile: 'work'
      })
    ).toEqual({ key: 'session_id', id: 'abc-123', hermesProfile: 'work' })
    expect(
      normalizeAgentProviderSession({
        key: 'session_id',
        id: 'abc-123',
        hermesProfile: 'a;b'
      })
    ).toEqual({ key: 'session_id', id: 'abc-123' })
    expect(
      normalizeAgentProviderSession({ key: 'session_id', id: 'abc-123', hermesProfile: 'default' })
    ).toEqual({ key: 'session_id', id: 'abc-123' })
  })
})
