import { describe, expect, it } from 'vitest'
import { translate } from '@/i18n/i18n'
import { cloudAgentStripModel } from './cloud-agent-strip-model'

const base = { agent: 'claude' as const, hostLabel: 'the sandbox', t: translate }

describe('cloudAgentStripModel', () => {
  it('account recovery (S4-c): Renew, account-level wording, no per-workspace words', () => {
    const model = cloudAgentStripModel({ ...base, reason: 'accountExpired', view: null })
    expect(model).toMatchObject({
      title: 'Your Claude sign-in expired',
      detail: 'Sign in once to fix every workspace.',
      primary: { label: 'Renew', action: { kind: 'renew' } }
    })
  })

  it('kill switch says paused; a provider never offered never does', () => {
    const paused = cloudAgentStripModel({ ...base, reason: 'paused', view: { step: 'need' } })
    expect(paused.title).toBe('Sign in to Claude for this workspace')
    expect(paused.detail).toBe('Orca account sign-in is paused')
    expect(paused.primary?.label).toBe('Use my Claude sign-in')
    const off = cloudAgentStripModel({ ...base, reason: 'notOffered', view: { step: 'need' } })
    expect(`${off.title} ${off.detail} ${off.description}`).not.toMatch(/paused/i)
    expect(off.detail).toBe('Signs in for each cloud workspace for now')
  })

  it('follows the per-workspace sign-in steps', () => {
    const waiting = cloudAgentStripModel({
      ...base,
      reason: 'paused',
      view: { step: 'waiting', url: 'https://claude.ai/x' }
    })
    expect(waiting).toMatchObject({ status: 'busy', detail: 'Approve on claude.ai' })
    const device = cloudAgentStripModel({
      ...base,
      agent: 'codex',
      reason: 'paused',
      view: { step: 'device', url: 'https://auth.openai.com/d', userCode: 'ABCD-1234' }
    })
    expect(device).toMatchObject({
      code: 'ABCD-1234',
      primary: {
        label: 'Copy code and open',
        action: { kind: 'copyAndOpen', url: 'https://auth.openai.com/d', code: 'ABCD-1234' }
      },
      detail: 'Only continue if you started this sign-in in Orca.'
    })
    const error = cloudAgentStripModel({
      ...base,
      reason: 'paused',
      view: { step: 'error', kind: 'timeout', message: 'raw cli text' }
    })
    expect(`${error.title} ${error.detail}`).not.toContain('raw cli text')
  })
})
