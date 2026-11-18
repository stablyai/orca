import { describe, expect, it } from 'vitest'
import {
  botAccessAdvice,
  botAccessReach,
  botReachLineText,
  googleReachAreas,
  botAccessSummary,
  botPermissionNotes,
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

describe('botPermissionNotes', () => {
  it('names a sandbox only for Codex', () => {
    expect(botPermissionNotes('codex', { mode: 'ask', fellBackFrom: null })).toEqual([
      'codexAsk',
      'whoeverAskedApproves'
    ])
    expect(botPermissionNotes('codex', { mode: 'auto', fellBackFrom: null })).toEqual([
      'codexOwnSandbox',
      'whoeverAskedApproves'
    ])
    expect(botPermissionNotes('codex', { mode: 'full-access', fellBackFrom: null })).toEqual([
      'codexNoSandbox'
    ])
    expect(botPermissionNotes('claude', { mode: 'auto', fellBackFrom: null })).toEqual([
      'whoeverAskedApproves'
    ])
  })

  it('says why a mode fell back, and that whoever asked can approve', () => {
    expect(botPermissionNotes('grok', { mode: 'ask', fellBackFrom: 'accept-edits' })).toEqual([
      'permissionFellBack',
      'whoeverAskedApproves'
    ])
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

describe('botAccessSummary', () => {
  it('names up to three people, then counts', () => {
    expect(botAccessSummary([]).who).toEqual({ id: 'summaryOnlyYou', values: {} })
    expect(botAccessSummary(['Bea']).who).toEqual({ id: 'summaryOne', values: { person: 'Bea' } })
    expect(botAccessSummary(['Bea', 'Cy', 'Dee']).who).toEqual({
      id: 'summarySome',
      values: { people: 'Bea, Cy', last: 'Dee' }
    })
    expect(botAccessSummary(['A', 'B', 'C', 'D']).who).toEqual({
      id: 'summaryMany',
      values: { count: 4 }
    })
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

  it('names Drive alone when Docs and Sheets aren’t ready', () => {
    const areas = googleReachAreas([
      {
        status: 'connected',
        services: [
          { service: 'drive', state: 'ready' },
          { service: 'docs', state: 'api-disabled' },
          { service: 'sheets', state: 'needs-permission' }
        ]
      }
    ])
    expect(areas).toEqual(['drive'])
    const text = botAccessReach({
      agent: 'claude',
      permission: { mode: 'ask', fellBackFrom: null },
      connector: null,
      google: areas
    })
      .filter((line) => line.kind === 'google')
      .map(
        (line) =>
          botReachLineText(line, {
            name: 'Reviewer',
            agentLabel: 'Claude',
            place: { computer: 'this computer' },
            mode: () => ({ label: '', description: '' })
          }).title
      )
    expect(text).toEqual(['Use your Drive files'])
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
