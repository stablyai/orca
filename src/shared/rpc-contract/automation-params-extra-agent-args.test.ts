import { describe, expect, it } from 'vitest'
import { AutomationCreate, AutomationUpdate } from './automation-params'
import { z } from 'zod'

const CREATE = {
  name: 'Docs pass',
  prompt: 'Tidy docs',
  agentId: 'claude',
  rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
  dtstart: 1
}

describe('extraAgentArgs RPC params', () => {
  it('retains complete sparse setup and rejects it on the shipped old strict envelope', () => {
    const launchSetupPatch = {
      choices: { model: null, options: { serviceTier: 'fast', effort: null } },
      sources: {
        arguments: { kind: 'empty' },
        extraAgentArgs: '--add-dir docs',
        retiredChoices: ['model', 'options.effort']
      }
    }
    expect(AutomationCreate.parse({ ...CREATE, launchSetupPatch }).launchSetupPatch).toEqual(
      launchSetupPatch
    )
    expect(
      AutomationUpdate.parse({ id: 'a', updates: { launchSetupPatch } }).updates.launchSetupPatch
    ).toEqual(launchSetupPatch)
    // The old envelope rejects modern members even when a preceding capability fact went stale.
    const old = z.strictObject({
      surface: z.enum(['chat', 'terminal']).optional(),
      arguments: z.strictObject({ kind: z.literal('legacy-extras'), value: z.string() }).optional()
    })
    expect(old.safeParse(launchSetupPatch).success).toBe(false)
    const copy = {
      agentArgs: null,
      launchPreferences: { model: null },
      extraAgentArgs: '--dormant'
    }
    expect(
      AutomationCreate.parse({ ...CREATE, launchSetupPatch: { copy } }).launchSetupPatch
    ).toEqual({ copy })
    expect(old.safeParse({ copy }).success).toBe(false)
  })
  it('keeps text unchanged, including empty text that clears on update', () => {
    expect(AutomationCreate.parse({ ...CREATE, extraAgentArgs: ' --model "a b" ' })).toMatchObject({
      extraAgentArgs: ' --model "a b" '
    })
    expect(
      AutomationUpdate.parse({ id: 'a', updates: { extraAgentArgs: '' } }).updates
    ).toMatchObject({ extraAgentArgs: '' })
    expect(AutomationUpdate.parse({ id: 'a', updates: {} }).updates.extraAgentArgs).toBeUndefined()
  })

  it.each([null, 42, ['--model', 'opus']])(
    'rejects %j instead of treating it as omitted',
    (value) => {
      expect(AutomationCreate.safeParse({ ...CREATE, extraAgentArgs: value }).success).toBe(false)
      expect(
        AutomationUpdate.safeParse({ id: 'a', updates: { extraAgentArgs: value } }).success
      ).toBe(false)
    }
  )
  it('accepts the surface-only setup contract and rejects empty or future patch members', () => {
    expect(
      AutomationCreate.parse({
        ...CREATE,
        launchSetupPatch: { surface: 'chat', arguments: { kind: 'legacy-extras', value: '' } }
      }).launchSetupPatch
    ).toEqual({ surface: 'chat', arguments: { kind: 'legacy-extras', value: '' } })
    for (const launchSetupPatch of [
      {},
      { surface: 'other' },
      { model: 'opus' },
      { arguments: { kind: 'full', value: 'x' } },
      { sources: { retiredChoices: ['extraAgentArgs'] } },
      { sources: { retiredChoices: ['options.__proto__'] } }
    ]) {
      expect(AutomationUpdate.safeParse({ id: 'a', updates: { launchSetupPatch } }).success).toBe(
        false
      )
    }
  })
})
