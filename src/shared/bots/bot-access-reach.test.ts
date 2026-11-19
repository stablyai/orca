import { describe, expect, it } from 'vitest'
import {
  botAccessConfirm,
  botAccessAdvice,
  botAccessReach,
  googleReachAreas,
  botStartingPermission
} from './bot-access-reach'

describe('botStartingPermission', () => {
  it('uses the bot’s own mode when its agent offers it', () => {
    expect(
      botStartingPermission({ agent: 'claude', permissionMode: 'accept-edits' }, 'ask')
    ).toEqual({ mode: 'accept-edits', fellBackFrom: null })
  })

  it('falls back to Ask for a mode the agent lacks, for every agent', () => {
    expect(botStartingPermission({ agent: 'codex', permissionMode: 'accept-edits' }, null)).toEqual(
      {
        mode: 'ask',
        fellBackFrom: 'accept-edits'
      }
    )
    expect(botStartingPermission({ agent: 'grok', permissionMode: 'auto' }, null)).toEqual({
      mode: 'ask',
      fellBackFrom: 'auto'
    })
  })

  it('follows the app’s new-chat choice when the bot has none, and knows nothing of “own”', () => {
    expect(botStartingPermission({ agent: 'claude' }, 'full-access').mode).toBe('full-access')
    expect(botStartingPermission({ agent: 'claude' }, 'own').mode).toBeNull()
    expect(botStartingPermission({ agent: 'claude' }, null).mode).toBeNull()
  })
})

describe('botAccessAdvice', () => {
  const full = { mode: 'full-access' as const, fellBackFrom: null }
  const ask = { mode: 'ask' as const, fellBackFrom: null }

  it('gives none while only the owner can ask', () => {
    expect(botAccessAdvice({ others: 0, permission: full, google: true })).toEqual({
      open: false,
      fixes: []
    })
  })

  it('gives none for a setup that asks first and has no Google', () => {
    expect(botAccessAdvice({ others: 2, permission: ask, google: false })).toEqual({
      open: false,
      fixes: []
    })
  })

  it('offers Keep only me, then Ask for approval, for Full access', () => {
    expect(botAccessAdvice({ others: 1, permission: full, google: false })).toEqual({
      open: true,
      fixes: ['only-me', 'ask-for-approval']
    })
  })

  it('offers turning Google off where the surface can, and Ask for Approve for me', () => {
    const auto = { mode: 'auto' as const, fellBackFrom: null }
    expect(botAccessAdvice({ others: 1, permission: auto, google: true })).toEqual({
      open: true,
      fixes: ['only-me', 'google-off', 'ask-for-approval']
    })
    expect(
      botAccessAdvice({ others: 1, permission: ask, google: true, canTurnOffGoogle: false })
    ).toEqual({ open: true, fixes: ['only-me'] })
  })

  it('shows a Pi bot as Full access whatever it saved, with no Ask for approval to offer', () => {
    const permission = botStartingPermission({ agent: 'pi', permissionMode: 'ask' }, 'ask')
    expect(permission).toEqual({ mode: 'full-access', fellBackFrom: null, fixed: true })
    expect(botAccessAdvice({ others: 1, permission, google: false })).toEqual({
      open: true,
      fixes: ['only-me']
    })
  })

  it('offers Ask for approval when the starting mode can’t be read', () => {
    expect(
      botAccessAdvice({ others: 1, permission: { mode: null, fellBackFrom: null }, google: true })
        .fixes
    ).toContain('ask-for-approval')
  })
})

describe('botAccessConfirm', () => {
  const at = (mode: 'ask' | 'auto' | 'full-access' | null) => ({ mode, fellBackFrom: null })

  it('is amber for Ask or Auto without Google: computer, who approves, the connector', () => {
    for (const mode of ['ask', 'auto'] as const) {
      expect(botAccessConfirm({ permission: at(mode), connector: 'slack', google: false })).toEqual(
        {
          tone: 'medium',
          rows: [
            { kind: 'computer' },
            { kind: 'approves' },
            { kind: 'connector', connector: 'slack' }
          ]
        }
      )
    }
  })

  it('is red for Full access, with no approvals, and one Google row for any area', () => {
    expect(
      botAccessConfirm({ permission: at('full-access'), connector: 'github', google: true })
    ).toEqual({
      tone: 'high',
      rows: [
        { kind: 'computer' },
        { kind: 'no-approvals' },
        { kind: 'google' },
        { kind: 'connector', connector: 'github' }
      ]
    })
  })

  it('is red when Google reaches or the starting mode can’t be read', () => {
    expect(
      botAccessConfirm({ permission: at('ask'), connector: 'linear', google: true }).tone
    ).toBe('high')
    const unknown = botAccessConfirm({ permission: at(null), connector: 'linear', google: false })
    expect(unknown.tone).toBe('high')
    expect(unknown.rows[1]).toEqual({ kind: 'may-skip-approvals' })
  })
})

describe('googleReachAreas', () => {
  const account = (
    services: {
      service: 'gmail' | 'calendar' | 'drive' | 'contacts'
      state: 'ready' | 'needs-permission'
    }[],
    status: 'connected' | 'reconnect' = 'connected'
  ) => ({ status, services })

  it('names only the services a connected account allows', () => {
    expect(googleReachAreas([account([{ service: 'calendar', state: 'ready' }])])).toEqual([
      'calendar'
    ])
    expect(
      googleReachAreas([
        account([
          { service: 'gmail', state: 'needs-permission' },
          { service: 'drive', state: 'ready' },
          { service: 'contacts', state: 'ready' }
        ])
      ])
    ).toEqual(['drive'])
  })

  it('reaches nothing through an account that needs reconnecting', () => {
    expect(
      googleReachAreas([account([{ service: 'gmail', state: 'ready' }], 'reconnect')])
    ).toEqual([])
  })
})

describe('botAccessReach', () => {
  it('lists one Google line per area, or one unknown line where they can’t be read', () => {
    const base = {
      agent: 'claude',
      permission: { mode: 'ask' as const, fellBackFrom: null },
      connector: null
    }
    expect(
      botAccessReach({ ...base, google: ['calendar'] }).filter((line) => line.kind === 'google')
    ).toEqual([{ kind: 'google', area: 'calendar' }])
    expect(
      botAccessReach({ ...base, google: null }).filter((line) => line.kind === 'google')
    ).toEqual([{ kind: 'google', area: null }])
    expect(botAccessReach({ ...base, google: [] }).some((line) => line.kind === 'google')).toBe(
      false
    )
  })
})
