import { describe, expect, it } from 'vitest'
import { validateAutomationListResponse } from './automation-list-response'
import type { AutomationListScopeSelector } from './automation-list-scope'

const SELF: AutomationListScopeSelector = { kind: 'self' }

function response(overrides: Record<string, unknown> = {}) {
  return {
    automations: [{ id: 'a1' }, { id: 'a2' }],
    items: [
      { automationId: 'a1', selector: { kind: 'self' } },
      { automationId: 'a2', selector: { kind: 'self' } }
    ],
    orphanCount: 3,
    ...overrides
  }
}

describe('validateAutomationListResponse', () => {
  it('accepts a capable response and keeps the reported orphan count', () => {
    const result = validateAutomationListResponse(response(), SELF)
    expect(result).toMatchObject({ ok: true, invalidRows: 0 })
    expect(result.ok && result.result.orphanCount).toBe(3)
    expect(result.ok && result.result.automations.map((entry) => entry.id)).toEqual(['a1', 'a2'])
  })

  // Why: the field is optional on the wire, so "not reported" must stay
  // distinguishable from "authoritatively none" — a fabricated zero settles the
  // authority's orphan bucket that nobody counted.
  it('leaves an omitted orphan count unreported instead of committing zero', () => {
    const raw = response()
    delete (raw as { orphanCount?: number }).orphanCount
    const result = validateAutomationListResponse(raw, SELF)
    expect(result).toMatchObject({ ok: true, invalidRows: 0 })
    expect(result.ok && result.result.orphanCount).toBeUndefined()
    expect(result.ok && 'orphanCount' in result.result).toBe(false)
  })

  it('reports a legacy-shaped payload as unsupported host scope', () => {
    const result = validateAutomationListResponse({ automations: [{ id: 'a1' }] }, SELF)
    expect(result).toMatchObject({ ok: false, error: { code: 'unsupported_host_scope' } })
  })

  it('rejects a malformed top-level response', () => {
    expect(validateAutomationListResponse(null, SELF)).toMatchObject({
      ok: false,
      error: { code: 'invalid_response' }
    })
    expect(validateAutomationListResponse({ automations: 'nope' }, SELF)).toMatchObject({
      ok: false,
      error: { code: 'invalid_response' }
    })
    expect(validateAutomationListResponse({ automations: [], items: {} }, SELF)).toMatchObject({
      ok: false,
      error: { code: 'invalid_response' }
    })
    expect(validateAutomationListResponse(response({ orphanCount: -1 }), SELF)).toMatchObject({
      ok: false,
      error: { code: 'invalid_response' }
    })
  })

  it('drops one unmatched row without hiding the rest of the host', () => {
    const result = validateAutomationListResponse(
      response({ items: [{ automationId: 'a1', selector: { kind: 'self' } }] }),
      SELF
    )
    expect(result.ok && result.result.automations.map((entry) => entry.id)).toEqual(['a1'])
    expect(result.ok && result.invalidRows).toBe(1)
  })

  it('drops both rows when one automation id carries two metadata items', () => {
    const result = validateAutomationListResponse(
      response({
        items: [
          { automationId: 'a1', selector: { kind: 'self' } },
          { automationId: 'a1', selector: { kind: 'ssh', targetId: 't', targetGeneration: 1 } },
          { automationId: 'a2', selector: { kind: 'self' } }
        ]
      }),
      SELF
    )
    expect(result.ok && result.result.automations.map((entry) => entry.id)).toEqual(['a2'])
    expect(result.ok && result.invalidRows).toBe(2)
  })

  it('never reclassifies a row whose selector does not match the request', () => {
    const result = validateAutomationListResponse(
      response({
        items: [
          { automationId: 'a1', selector: { kind: 'ssh', targetId: 'ssh-1', targetGeneration: 2 } },
          { automationId: 'a2', selector: { kind: 'self' } }
        ]
      }),
      SELF
    )
    expect(result.ok && result.result.automations.map((entry) => entry.id)).toEqual(['a2'])
    expect(result.ok && result.result.items[0]?.selector).toEqual({ kind: 'self' })
    expect(result.ok && result.invalidRows).toBe(1)
  })

  it('requires an SSH item to carry the requested generation', () => {
    const scope: AutomationListScopeSelector = {
      kind: 'ssh',
      targetId: 'ssh-1',
      expectedTargetGeneration: 4
    }
    const stale = validateAutomationListResponse(
      response({
        items: [
          { automationId: 'a1', selector: { kind: 'ssh', targetId: 'ssh-1', targetGeneration: 3 } },
          { automationId: 'a2', selector: { kind: 'ssh', targetId: 'ssh-1', targetGeneration: 4 } }
        ]
      }),
      scope
    )
    expect(stale.ok && stale.result.automations.map((entry) => entry.id)).toEqual(['a2'])
    expect(stale.ok && stale.invalidRows).toBe(1)
  })

  it('drops rows whose metadata is structurally unusable', () => {
    const result = validateAutomationListResponse(
      response({
        automations: [{ id: 'a1' }, { name: 'no id' }],
        items: [
          { automationId: 'a1', selector: { kind: 'ssh', targetId: 'ssh-1' } },
          { selector: { kind: 'self' } }
        ]
      }),
      SELF
    )
    expect(result.ok && result.result.automations).toEqual([])
    expect(result.ok && result.invalidRows).toBe(4)
  })

  it('keeps a row whose usage summary is unusable but blanks the summary', () => {
    const result = validateAutomationListResponse(
      response({
        automations: [{ id: 'a1' }],
        items: [{ automationId: 'a1', selector: { kind: 'self' }, usageSummary: { knownRuns: 1 } }]
      }),
      SELF
    )
    expect(result.ok && result.result.items[0]?.usageSummary).toBeNull()
    expect(result.ok && result.invalidRows).toBe(0)
  })
})
