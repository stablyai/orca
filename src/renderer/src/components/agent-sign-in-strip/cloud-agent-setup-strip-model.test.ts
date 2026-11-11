import { describe, expect, it } from 'vitest'
import type { Translate } from '@/i18n/use-translate'
import { cloudAgentSetupStripModel } from './cloud-agent-setup-strip-model'

const t: Translate = (_key, fallback, options) =>
  fallback.replace(/\{\{(\w+)\}\}/g, (_m, name: string) => String(options?.[name] ?? ''))

describe('cloudAgentSetupStripModel (PC-3b)', () => {
  it('asks to set up once while nothing is running', () => {
    const model = cloudAgentSetupStripModel({
      agent: 'claude',
      setup: { phase: 'idle' },
      ready: false,
      t
    })
    expect(model.title).toBe('Claude isn’t set up for Orca Cloud')
    expect(model.primary).toMatchObject({ label: 'Set up once', action: { kind: 'setUpOnce' } })
  })

  it('follows the setup: browser, device code, failure with Try again', () => {
    const browser = cloudAgentSetupStripModel({
      agent: 'claude',
      setup: { phase: 'browser', startedAt: 1, canReopen: true },
      ready: false,
      t
    })
    expect(browser).toMatchObject({ status: 'busy', primary: { action: { kind: 'reopenSetup' } } })
    const device = cloudAgentSetupStripModel({
      agent: 'codex',
      setup: {
        phase: 'device',
        startedAt: 1,
        userCode: 'ABCD-1234',
        verificationUrl: 'https://auth.openai.com/codex/device',
        expiresAt: 2
      },
      ready: false,
      t
    })
    expect(device.code).toBe('ABCD-1234')
    expect(device.primary?.action).toMatchObject({ kind: 'copyAndOpen', code: 'ABCD-1234' })
    const failed = cloudAgentSetupStripModel({
      agent: 'claude',
      setup: { phase: 'failed', error: 'denied' },
      ready: false,
      t
    })
    expect(failed).toMatchObject({ status: 'error', primary: { action: { kind: 'setUpOnce' } } })
  })

  it('offers Start once the account covers the agent', () => {
    const model = cloudAgentSetupStripModel({
      agent: 'claude',
      setup: { phase: 'saved' },
      ready: true,
      t
    })
    expect(model).toMatchObject({
      status: 'done',
      primary: { label: 'Start Claude', action: { kind: 'start' } }
    })
  })
})
