// P0 "Set up once": the strip (terminal pane and chat UI) takes the code Claude's sign-in page shows.
import { describe, expect, it } from 'vitest'
import type { Translate } from '@/i18n/use-translate'
import { cloudAgentSetupStripModel } from './cloud-agent-setup-strip-model'
import { looksLikeWholeSetupCode } from './CloudStripPasteForm'

const t: Translate = (_key, fallback, options) =>
  fallback.replace(/\{\{(\w+)\}\}/g, (_m, name: string) => String(options?.[name] ?? ''))

const model = (setup: Parameters<typeof cloudAgentSetupStripModel>[0]['setup']) =>
  cloudAgentSetupStripModel({ agent: 'claude', setup, ready: false, t })

describe('the setup strip with a code to paste back', () => {
  it('before the CLI waits for a code: no field, the plain browser detail', () => {
    const strip = model({ phase: 'browser', startedAt: 1, canReopen: false })
    expect(strip.paste).toBeNull()
    expect(strip.detail).toBe('Finish in your browser')
  })

  it('[Paste code] [Finish setup] [Open again], masked, with the paste hint', () => {
    const strip = model({ phase: 'browser', startedAt: 1, canReopen: true, acceptsCode: true })
    expect(strip.detail).toBe('Finish in your browser, then paste the code here.')
    expect(strip.paste).toMatchObject({
      submitting: false,
      refusal: null,
      secretLabel: 'Code from Claude’s sign-in page',
      setupCode: { placeholder: 'Paste code', submitLabel: 'Finish setup' }
    })
    expect(strip.primary).toMatchObject({ label: 'Open again', action: { kind: 'reopenSetup' } })
  })

  it('checking, then a refused code keeps the field with one message', () => {
    const checking = model({
      phase: 'browser',
      startedAt: 1,
      canReopen: true,
      acceptsCode: true,
      code: 'checking'
    })
    expect(checking.paste).toMatchObject({
      submitting: true,
      setupCode: { submitLabel: 'Checking the code…' }
    })
    const refused = model({
      phase: 'browser',
      startedAt: 1,
      canReopen: false,
      acceptsCode: true,
      code: 'rejected'
    })
    expect(refused.paste?.refusal).toBe(
      'That code didn’t work. Paste the newest code from the sign-in page, or open it again.'
    )
  })

  it('an expired sign-in stops spinning and offers "Open again" (a fresh run)', () => {
    const expired = model({ phase: 'failed', error: 'timed_out' })
    expect(expired.status).toBe('error')
    expect(expired.primary).toMatchObject({ label: 'Open again', action: { kind: 'reopenSetup' } })
  })
})

describe('looksLikeWholeSetupCode (auto-submit on paste)', () => {
  it('takes a whole code or the callback URL, not a fragment', () => {
    expect(looksLikeWholeSetupCode(' FAKEcode0123456789#FAKEstate0123 ')).toBe(true)
    expect(
      looksLikeWholeSetupCode(
        'https://platform.claude.com/oauth/code/callback?code=FAKEcode0123&state=s'
      )
    ).toBe(true)
    expect(looksLikeWholeSetupCode('FAKEcode0123456789')).toBe(false)
    expect(looksLikeWholeSetupCode('FAKE#x')).toBe(false)
  })
})
