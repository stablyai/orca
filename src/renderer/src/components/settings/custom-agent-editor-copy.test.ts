import { describe, expect, it } from 'vitest'
import type { AgentCatalogMutationResult } from '../../../../shared/agent-catalog-snapshot'
import {
  agentEditorFieldLabel,
  describeAgentFieldIssue,
  describeMutationFailure,
  findFieldError,
  reservedBuiltInLabelError,
  type CustomAgentEditorFieldError
} from './custom-agent-editor-copy'

describe('describeAgentFieldIssue', () => {
  it('maps a label emptiness to a name prompt', () => {
    const error = describeAgentFieldIssue({ field: 'label', reason: 'empty' })
    expect(error?.field).toBe('label')
    expect(error?.message).toContain('name')
  })

  it('carries the env row index through', () => {
    const error = describeAgentFieldIssue({
      field: 'env',
      reason: 'reserved_name',
      envEntryIndex: 2
    })
    expect(error?.field).toBe('env')
    expect(error?.envEntryIndex).toBe(2)
    expect(error?.message).toContain('ORCA_')
  })

  it('explains a quoted line break in args', () => {
    const error = describeAgentFieldIssue({ field: 'args', reason: 'quoted_line_break' })
    expect(error?.message.toLowerCase()).toContain('multiple lines')
  })

  it('surfaces the aggregate 16 KiB env cap as a section-level error', () => {
    const error = describeAgentFieldIssue({ field: 'env', reason: 'env_total_bounds' })
    expect(error?.field).toBe('env')
    expect(error?.message).toContain('16 KiB')
  })

  it('ignores identity/baseAgent fields the editor does not own', () => {
    expect(describeAgentFieldIssue({ field: 'identity', reason: 'duplicate_id' })).toBeNull()
    expect(describeAgentFieldIssue({ field: 'baseAgent', reason: 'identity_mismatch' })).toBeNull()
  })
})

describe('reservedBuiltInLabelError', () => {
  it('flags a built-in canonical name and names the harness', () => {
    const error = reservedBuiltInLabelError('Claude')
    expect(error?.field).toBe('label')
    expect(error?.message).toContain('Claude')
  })

  it('matches case-insensitively after normalization', () => {
    expect(reservedBuiltInLabelError('  codex  ')).not.toBeNull()
  })

  it('allows a non-reserved name and an empty name', () => {
    expect(reservedBuiltInLabelError('My Fast Codex')).toBeNull()
    expect(reservedBuiltInLabelError('')).toBeNull()
  })
})

describe('findFieldError', () => {
  const errors: CustomAgentEditorFieldError[] = [
    { field: 'label', message: 'a' },
    { field: 'env', envEntryIndex: 1, message: 'row' },
    { field: 'env', message: 'section' }
  ]

  it('matches a non-env field directly', () => {
    expect(findFieldError(errors, 'label')?.message).toBe('a')
  })

  it('matches an env row by index', () => {
    expect(findFieldError(errors, 'env', 1)?.message).toBe('row')
  })

  it('matches the section-level env error when no index is given', () => {
    expect(findFieldError(errors, 'env')?.message).toBe('section')
  })
})

describe('describeMutationFailure', () => {
  it('routes a duplicate label to the name field', () => {
    const result = { ok: false, code: 'duplicate_agent_label', revision: 3 } as Extract<
      AgentCatalogMutationResult,
      { ok: false }
    >
    const copy = describeMutationFailure(result, { field: 'label' })
    expect(copy.scope).toBe('field')
    if (copy.scope === 'field') {
      expect(copy.error.field).toBe('label')
      expect(copy.focus.field).toBe('label')
    }
  })

  it('maps an invalid field to the focused control and reason', () => {
    const result = {
      ok: false,
      code: 'invalid_agent_field',
      revision: 4,
      field: 'env',
      reason: 'case_collision',
      envEntryIndex: 0
    } as Extract<AgentCatalogMutationResult, { ok: false }>
    const copy = describeMutationFailure(result, { field: 'env', envEntryIndex: 0 })
    expect(copy.scope).toBe('field')
    if (copy.scope === 'field') {
      expect(copy.error.envEntryIndex).toBe(0)
      expect(copy.error.message.toLowerCase()).toContain('already uses this name')
    }
  })

  it('treats a revision conflict as a form-level banner (draft preserved)', () => {
    const result = { ok: false, code: 'catalog_revision_conflict', revision: 5 } as Extract<
      AgentCatalogMutationResult,
      { ok: false }
    >
    const copy = describeMutationFailure(result, null)
    expect(copy.scope).toBe('form')
    if (copy.scope === 'form') {
      expect(copy.error.message.toLowerCase()).toContain('changed')
    }
  })

  it('tells the user a failed durable write saved nothing, not just to reload', () => {
    const result = { ok: false, code: 'agent_catalog_write_failed', revision: 7 } as Extract<
      AgentCatalogMutationResult,
      { ok: false }
    >
    const copy = describeMutationFailure(result, { field: 'label' })
    expect(copy.scope).toBe('form')
    if (copy.scope === 'form') {
      expect(copy.error.message.toLowerCase()).toContain('nothing was changed')
      expect(copy.error.message.toLowerCase()).not.toContain('reload settings')
    }
  })

  it('treats an oversize payload as a form-level banner', () => {
    const result = { ok: false, code: 'agent_catalog_payload_too_large', revision: 6 } as Extract<
      AgentCatalogMutationResult,
      { ok: false }
    >
    expect(describeMutationFailure(result, null).scope).toBe('form')
  })
})

describe('agentEditorFieldLabel', () => {
  it('names each editable field', () => {
    expect(agentEditorFieldLabel('label')).toBe('Name')
    expect(agentEditorFieldLabel('commandOverride')).toBe('Executable')
    expect(agentEditorFieldLabel('args')).toBe('Arguments')
    expect(agentEditorFieldLabel('env')).toBe('Environment variables')
  })
})
