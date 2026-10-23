import { describe, expect, it } from 'vitest'
import { normalizeAgentProviderSession, agentProviderSessionsEqual } from './agent-session-resume'
import { sleepingAgentSessionRecordSchema } from './workspace-session-sleeping-agents'
import { ResumeProviderSessionParam } from './rpc-contract/terminal-unary-params'
import { recoveryRecordMatches } from './agent-resume-record-equivalence'
import { normalizeRemoteEnvelopeFields } from '../main/agent-hooks/server/server-remote-envelope-normalization'
import { sanitizeHydratedEntry } from '../main/agent-hooks/server/server-persistence-validation'

const origin = {
  installationId: 'install',
  machineBinding: 'binding',
  host: { kind: 'local' }
} as const
const config = {
  kind: 'explicit',
  value: "/project/用户 'quoted'/.claude",
  userHome: '/home/original'
} as const
const providerSession = {
  key: 'session_id',
  id: 'session',
  transcriptPath: '/transcript.jsonl',
  claudeConfig: config,
  claudeConfigOrigin: origin
} as const
const record = {
  paneKey: 'tab:11111111-1111-4111-8111-111111111111',
  worktreeId: 'repo::/work',
  agent: 'claude',
  providerSession,
  state: 'working',
  prompt: '',
  capturedAt: 1,
  updatedAt: 1
} as const

describe('Claude observed resume context persistence', () => {
  it('retains exact literal context through relay, RPC, status hydration and sleeping record schemas', () => {
    expect(normalizeAgentProviderSession(providerSession)).toEqual(providerSession)
    expect(ResumeProviderSessionParam.parse(providerSession)).toEqual(providerSession)
    expect(
      normalizeRemoteEnvelopeFields({ source: 'claude', providerSession }).providerSession
    ).toEqual(providerSession)
    expect(sleepingAgentSessionRecordSchema.parse(record).providerSession).toEqual(providerSession)
    expect(
      sanitizeHydratedEntry(record.paneKey, {
        paneKey: record.paneKey,
        source: 'claude',
        receivedAt: 1,
        stateStartedAt: 1,
        providerSession,
        payload: { agentType: 'claude', state: 'working', prompt: '' }
      })?.providerSession
    ).toEqual(providerSession)
  })

  it.each([
    { kind: 'explicit', value: 'relative', userHome: '/home/original' },
    { ...config, value: '/root/../other' },
    { ...config, value: '/root/./other' },
    { ...config, value: '/root/invalid\npath' },
    { ...config, value: '\\\\?\\C:\\config' },
    { ...config, value: '\\\\.\\pipe\\config' },
    { ...config, value: 'C:\\root\\config:stream' },
    { ...config, value: 'C:\\root\\NUL' },
    { ...config, value: 'C:\\root\\trailing.' },
    { ...config, userHome: '' },
    { ...config, value: `/${'x'.repeat(4096)}` },
    { ...config, tokens: 'forbidden' },
    { kind: 'default', userHome: '/home/original', value: '/unexpected' },
    null
  ])('drops malformed context without losing the recovery record: %j', (claudeConfig) => {
    const parsed = sleepingAgentSessionRecordSchema.parse({
      ...record,
      providerSession: { ...providerSession, claudeConfig }
    })
    expect(parsed.providerSession).toEqual({
      key: 'session_id',
      id: 'session',
      transcriptPath: '/transcript.jsonl'
    })
  })

  it.each(['/home/original/.claude', 'C:\\Users\\Original\\.claude', '\\\\server\\share\\profile'])(
    'keeps an explicit literal store explicit (%s)',
    (value) => {
      const parsed = sleepingAgentSessionRecordSchema.parse({
        ...record,
        providerSession: {
          ...providerSession,
          claudeConfig: { ...config, value }
        }
      })
      expect(parsed.providerSession.claudeConfig).toEqual({ ...config, value })
    }
  )

  it('persists enrichment without treating it as a different provider session', () => {
    const before = { ...record, providerSession: { key: 'session_id', id: 'session' } as const }
    expect(agentProviderSessionsEqual('claude', before.providerSession, providerSession)).toBe(true)
    expect(recoveryRecordMatches(before, record)).toBe(false)
    expect(recoveryRecordMatches(record, record)).toBe(true)
    expect(recoveryRecordMatches(before, before)).toBe(true)
    expect(
      recoveryRecordMatches(record, {
        ...record,
        providerSession: {
          ...providerSession,
          claudeConfig: { kind: 'default', userHome: config.userHome }
        }
      })
    ).toBe(false)
  })
})
