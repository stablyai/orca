// CHAT-RENEW-INPLACE: every expired strip renews in place, with design-squad's per-step copy.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { OrcaCloudAgentSetup } from '../../../../shared/orca-cloud-agents/orca-cloud-agents-wire'
import type { CloudStripActions } from './CloudAgentSignInStrip'
import type { CloudStripModel } from './cloud-agent-strip-model'
import { translate as t } from '@/i18n/i18n'

const store = vi.hoisted(() => ({ run: vi.fn(), stop: vi.fn() }))
vi.mock('@/lib/orca-cloud/orca-cloud-agent-accounts-store', () => ({
  runOrcaCloudAgentSetups: store.run,
  stopOrcaCloudAgentSetups: store.stop,
  reloadOrcaCloudAgentAccounts: async () => undefined
}))
vi.mock('@/lib/orca-cloud/cloud-agent-launch-hold', () => ({
  releaseCloudAgentHold: vi.fn(),
  startCloudAgentHold: vi.fn()
}))
vi.mock('@/store', () => ({ useAppStore: { getState: () => ({}) } }))
vi.mock('../agent-sign-in/AgentSignInPanePortals', () => ({
  agentSignInCardActions: () => ({ copyText: vi.fn(), openLink: vi.fn() })
}))
const api = vi.hoisted(() => ({ reopen: vi.fn(async () => undefined), submitClaudeCode: vi.fn() }))
vi.stubGlobal('window', { api: { orcaCloudAgents: api } })

const { cloudRenewInPlaceActions, cloudRenewInPlaceModel } = await import('./cloud-renew-in-place')

const EXPIRED: CloudStripModel = {
  status: 'warning',
  title: 'Your Claude sign-in expired',
  detail: 'Renew to keep working. Your conversation is kept.',
  description: null,
  primary: { label: 'Renew', action: { kind: 'renew' } },
  code: null,
  paste: null,
  otherWays: false,
  announcement: 'Your Claude sign-in expired.'
}

const model = (setup: OrcaCloudAgentSetup) =>
  cloudRenewInPlaceModel({ agent: 'claude', expired: EXPIRED, setup, t })

describe('cloudRenewInPlaceModel (design-squad per-step copy)', () => {
  it("1 expired: the surface's own strip, [Renew], no Settings link", () => {
    expect(model({ phase: 'idle' })).toBe(EXPIRED)
  })

  it('saved, before the account read lands: still "Checking the code…", never a flash of Renew', () => {
    const shown = model({ phase: 'saved' })
    expect(shown.title).toBe('Your Claude sign-in expired')
    expect(shown.paste).toMatchObject({ submitting: true })
    expect(shown.paste?.setupCode?.submitLabel).toBe('Checking the code…')
    expect(shown.primary?.action.kind).not.toBe('renew')
    expect(shown.noClose).toBe(true)
    expect(shown.settingsLink).toBeUndefined()
  })

  it('the setup is per agent: one renewal shows steps 2-4 on every expired surface for that agent', () => {
    const setup: OrcaCloudAgentSetup = {
      phase: 'browser',
      startedAt: 0,
      canReopen: true,
      acceptsCode: true
    }
    const held = cloudRenewInPlaceModel({
      agent: 'claude',
      expired: { ...EXPIRED, detail: 'Renew to start Claude.' },
      setup,
      t
    })
    const chat = cloudRenewInPlaceModel({ agent: 'claude', expired: EXPIRED, setup, t })
    for (const shown of [held, chat]) {
      expect(shown.detail).toBe('Finish in your browser, then paste the code here.')
      expect(shown.settingsLink).toBe('Renew in Settings')
    }
  })

  it('2 browser: same title, paste code, [Finish renewing] [Open again], "Renew in Settings"', () => {
    const shown = model({ phase: 'browser', startedAt: 0, canReopen: true, acceptsCode: true })
    expect(shown.title).toBe('Your Claude sign-in expired')
    expect(shown.detail).toBe('Finish in your browser, then paste the code here.')
    expect(shown.paste?.setupCode).toEqual({
      placeholder: 'Paste code',
      submitLabel: 'Finish renewing'
    })
    expect(shown.primary).toMatchObject({ label: 'Open again', action: { kind: 'reopenSetup' } })
    expect(shown.settingsLink).toBe('Renew in Settings')
    expect(JSON.stringify(shown)).not.toContain('Finish setup')
  })

  it('3 checking: the field and its button disabled', () => {
    const shown = model({
      phase: 'browser',
      startedAt: 0,
      canReopen: true,
      acceptsCode: true,
      code: 'checking'
    })
    expect(shown.paste).toMatchObject({ submitting: true })
    expect(shown.paste?.setupCode?.submitLabel).toBe('Checking the code…')
  })

  it('4 rejected: "Code didn\'t work", the newest-code detail, [Open again] and the Settings link', () => {
    const shown = model({
      phase: 'browser',
      startedAt: 0,
      canReopen: true,
      acceptsCode: true,
      code: 'rejected'
    })
    expect(shown.title).toBe('Code didn’t work')
    expect(shown.detail).toBe('Paste the newest code from the sign-in page, or open it again.')
    expect(shown.paste?.refusal).toBeTruthy()
    expect(shown.primary?.action.kind).toBe('reopenSetup')
    expect(shown.settingsLink).toBe('Renew in Settings')
  })

  it('a setup that failed outright starts again from Renew', () => {
    const shown = model({ phase: 'failed', error: 'denied' })
    expect(shown.status).toBe('error')
    expect(shown.primary?.action.kind).toBe('renew')
  })
})

describe('cloudRenewInPlaceActions', () => {
  const surface = (): CloudStripActions => ({
    primary: vi.fn(),
    submitCode: vi.fn(),
    pasteCode: vi.fn(),
    useCode: vi.fn(),
    useApiKey: vi.fn(),
    cancel: vi.fn()
  })
  const actions = (setup: OrcaCloudAgentSetup, own = surface(), openSettings = vi.fn()) => ({
    own,
    openSettings,
    built: cloudRenewInPlaceActions({
      agent: 'claude',
      setup,
      surface: own,
      openSettings,
      copyText: vi.fn(),
      openLink: vi.fn()
    })
  })
  beforeEach(() => {
    store.run.mockClear()
    store.stop.mockClear()
    api.reopen.mockClear()
  })

  it('Renew runs the setup here (never the Settings page or the sign-in sheet)', () => {
    const { built, own, openSettings } = actions({ phase: 'idle' })
    built.primary({ kind: 'renew' })
    expect(store.run).toHaveBeenCalledExactlyOnceWith(['claude'])
    expect(own.primary).not.toHaveBeenCalled()
    expect(openSettings).not.toHaveBeenCalled()
  })

  it('Open again reopens the setup page; "Renew in Settings" opens Settings', () => {
    const { built, openSettings } = actions({ phase: 'browser', startedAt: 0, canReopen: true })
    built.primary({ kind: 'reopenSetup' })
    expect(api.reopen).toHaveBeenCalledExactlyOnceWith({ agent: 'claude' })
    built.openSettings?.()
    expect(openSettings).toHaveBeenCalledOnce()
  })

  it('× in a failed renewal also goes back to step 1 (uniform ×)', () => {
    const { built, own } = actions({ phase: 'failed', error: 'denied' })
    built.cancel()
    expect(store.stop).toHaveBeenCalledExactlyOnceWith('claude')
    expect(own.cancel).not.toHaveBeenCalled()
  })

  it("× on any surface stops the agent's one renewal for all of them", () => {
    const setup: OrcaCloudAgentSetup = { phase: 'browser', startedAt: 0, canReopen: true }
    actions(setup).built.cancel()
    actions(setup).built.cancel()
    // Every surface stops the same per-agent setup; there is no per-surface renewal.
    expect(store.stop.mock.calls).toEqual([['claude'], ['claude']])
  })

  it('6: × mid-flow stops the setup (back to step 1) and never dismisses the strip', () => {
    const { built, own } = actions({ phase: 'browser', startedAt: 0, canReopen: true })
    built.cancel()
    expect(store.stop).toHaveBeenCalledExactlyOnceWith('claude')
    expect(own.cancel).not.toHaveBeenCalled()
  })

  it('outside a renewal, the surface keeps its own × and Restart', () => {
    const { built, own } = actions({ phase: 'idle' })
    built.cancel()
    built.primary({ kind: 'restart' })
    expect(store.stop).not.toHaveBeenCalled()
    expect(own.cancel).toHaveBeenCalledOnce()
    expect(own.primary).toHaveBeenCalledExactlyOnceWith({ kind: 'restart' })
  })
})
