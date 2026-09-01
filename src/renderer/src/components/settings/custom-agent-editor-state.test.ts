import { describe, expect, it } from 'vitest'
import type { BuiltInTuiAgent, CustomTuiAgentId } from '../../../../shared/types'
import type {
  AgentCatalogMutationResult,
  CustomAgentEditableFields
} from '../../../../shared/agent-catalog-snapshot'
import {
  buildMutation,
  builtInDraftFromSettings,
  createEnvRow,
  draftFromEditableFields,
  duplicateEnvKeyIssues,
  emptyDraft,
  isBaseSelectableMode,
  previewArgsTokens,
  resolveMutationErrorFocus,
  serializeEnvRows,
  toBuiltInAgentChanges,
  toCustomAgentDraft,
  validateDraftLocally,
  type CustomAgentEditorDraft
} from './custom-agent-editor-state'

const CODEX: BuiltInTuiAgent = 'codex'
const CUSTOM_ID = 'custom-agent:codex:11111111-1111-4111-8111-111111111111' as CustomTuiAgentId

function draftWith(overrides: Partial<CustomAgentEditorDraft> = {}): CustomAgentEditorDraft {
  return { ...emptyDraft(CODEX), ...overrides }
}

describe('emptyDraft', () => {
  it('starts blank with one env row and no paired-env opt-in', () => {
    const draft = emptyDraft(CODEX)
    expect(draft).toMatchObject({
      baseAgent: 'codex',
      label: '',
      commandOverride: '',
      args: '',
      syncEnv: false
    })
    expect(draft.envRows).toHaveLength(1)
    expect(draft.envRows[0]).toMatchObject({ key: '', value: '', revealed: false })
  })
})

describe('draftFromEditableFields', () => {
  it('maps stored fields and preserves env order', () => {
    const fields: CustomAgentEditableFields = {
      label: 'Codex Work',
      commandOverride: '/opt/codex-work',
      args: '--model gpt-5',
      env: { CODEX_HOME: '/a', OPENAI_BASE_URL: '/b' },
      syncEnv: true
    }
    const draft = draftFromEditableFields(fields, CODEX)
    expect(draft).toMatchObject({
      label: 'Codex Work',
      commandOverride: '/opt/codex-work',
      args: '--model gpt-5',
      syncEnv: true
    })
    expect(draft.envRows.map((r) => [r.key, r.value])).toEqual([
      ['CODEX_HOME', '/a'],
      ['OPENAI_BASE_URL', '/b']
    ])
  })

  it('renders a null override as empty text and seeds a blank row for empty env', () => {
    const draft = draftFromEditableFields(
      { label: 'X', commandOverride: null, args: '', env: {}, syncEnv: false },
      CODEX
    )
    expect(draft.commandOverride).toBe('')
    expect(draft.envRows).toHaveLength(1)
    expect(draft.envRows[0]).toMatchObject({ key: '', value: '' })
  })
})

describe('serializeEnvRows', () => {
  it('drops fully blank rows, keeps a value-only row, preserves order', () => {
    const env = serializeEnvRows([
      createEnvRow({ key: 'A', value: '1' }),
      createEnvRow(),
      createEnvRow({ key: '', value: 'orphan' }),
      createEnvRow({ key: 'B', value: '2' })
    ])
    expect(Object.entries(env)).toEqual([
      ['A', '1'],
      ['', 'orphan'],
      ['B', '2']
    ])
  })
})

describe('duplicateEnvKeyIssues', () => {
  it('reports a duplicate at the serialized index, not the raw array index', () => {
    // A fully-blank row before the duplicate makes raw and serialized indices
    // diverge; the editor renders per-row errors against the serialized index, so
    // a raw index here would block Save while showing the error on no row.
    const issues = duplicateEnvKeyIssues([
      createEnvRow({ key: 'A', value: '1' }),
      createEnvRow(),
      createEnvRow({ key: 'A', value: '2' })
    ])
    expect(issues).toEqual([{ field: 'env', reason: 'case_collision', envEntryIndex: 1 }])
  })

  it('flags a repeated blank key so its collapsed value is not silently dropped', () => {
    const issues = duplicateEnvKeyIssues([
      createEnvRow({ key: '', value: '1' }),
      createEnvRow({ key: '', value: '2' })
    ])
    expect(issues).toEqual([{ field: 'env', reason: 'case_collision', envEntryIndex: 1 }])
  })

  it('does not flag distinct keys or a single blank-key row', () => {
    expect(
      duplicateEnvKeyIssues([
        createEnvRow({ key: 'A', value: '1' }),
        createEnvRow({ key: 'B', value: '2' }),
        createEnvRow({ key: '', value: 'orphan' })
      ])
    ).toEqual([])
  })
})

describe('toCustomAgentDraft', () => {
  it('normalizes the label, drops an empty override, and canonicalizes args line endings', () => {
    const payload = toCustomAgentDraft(
      draftWith({
        label: '  Codex   Work  ',
        commandOverride: '   ',
        args: '--model x\r\n--safe',
        envRows: [createEnvRow({ key: 'CODEX_HOME', value: '/x' })]
      })
    )
    expect(payload.label).toBe('Codex Work')
    expect(payload.commandOverride).toBeNull()
    expect(payload.args).toBe('--model x\n--safe')
    expect(payload.env).toEqual({ CODEX_HOME: '/x' })
  })

  it('decodes a single matched outer quote pair on the executable override', () => {
    const payload = toCustomAgentDraft(draftWith({ commandOverride: '"/opt/my codex"' }))
    expect(payload.commandOverride).toBe('/opt/my codex')
  })
})

describe('buildMutation', () => {
  it('creates for new mode', () => {
    const mutation = buildMutation({ kind: 'new' }, draftWith({ label: 'Work' }))
    expect(mutation).toMatchObject({ kind: 'create', baseAgent: 'codex' })
    expect(mutation.kind === 'create' && mutation.draft.label).toBe('Work')
  })

  it('updates the addressed id for edit mode', () => {
    const mutation = buildMutation({ kind: 'edit', id: CUSTOM_ID }, draftWith({ label: 'Work' }))
    expect(mutation).toMatchObject({ kind: 'update-custom', id: CUSTOM_ID })
  })

  it('repair-edit updates the addressed id in place', () => {
    const mutation = buildMutation(
      { kind: 'repair-edit', id: CUSTOM_ID, repairToken: 'tok', baseAgent: CODEX },
      draftWith({ label: 'Fixed' })
    )
    expect(mutation).toMatchObject({ kind: 'update-custom', id: CUSTOM_ID })
    expect(mutation.kind === 'update-custom' && mutation.changes.label).toBe('Fixed')
  })

  it('repair-replace mints a fresh agent through repair-corrupt/replace', () => {
    const mutation = buildMutation(
      { kind: 'repair-replace', repairToken: 'tok' },
      draftWith({ label: 'New One', baseAgent: CODEX })
    )
    expect(mutation).toMatchObject({
      kind: 'repair-corrupt',
      repairToken: 'tok',
      action: { kind: 'replace', baseAgent: 'codex' }
    })
    expect(
      mutation.kind === 'repair-corrupt' &&
        mutation.action.kind === 'replace' &&
        mutation.action.draft.label
    ).toBe('New One')
  })

  it('duplicate submits only source and label — never the edited fields', () => {
    const mutation = buildMutation(
      { kind: 'duplicate', sourceAgent: CODEX },
      draftWith({ label: '  Codex Copy  ', args: '--ignored', commandOverride: '/ignored' })
    )
    expect(mutation).toEqual({ kind: 'duplicate', sourceAgent: 'codex', label: 'Codex Copy' })
  })
})

describe('validateDraftLocally', () => {
  it('accepts a well-formed new draft', () => {
    const issues = validateDraftLocally(
      { kind: 'new' },
      draftWith({
        label: 'Work',
        args: '--model gpt-5',
        envRows: [createEnvRow({ key: 'CODEX_HOME', value: '/x' })]
      })
    )
    expect(issues).toEqual([])
  })

  it('flags an empty label', () => {
    const issues = validateDraftLocally({ kind: 'new' }, draftWith({ label: '   ' }))
    expect(issues).toContainEqual({ field: 'label', reason: 'empty' })
  })

  it('flags a reserved ORCA_ env key with its entry index', () => {
    const issues = validateDraftLocally(
      { kind: 'new' },
      draftWith({ label: 'Work', envRows: [createEnvRow({ key: 'ORCA_PANE_KEY', value: 'x' })] })
    )
    expect(issues).toContainEqual({ field: 'env', reason: 'reserved_name', envEntryIndex: 0 })
  })

  it('flags an exact-duplicate env key that would collapse in the serialized record', () => {
    const issues = validateDraftLocally(
      { kind: 'new' },
      draftWith({
        label: 'Work',
        envRows: [
          createEnvRow({ key: 'HOME', value: '/a' }),
          createEnvRow({ key: 'HOME', value: '/b' })
        ]
      })
    )
    expect(issues).toContainEqual({ field: 'env', reason: 'case_collision', envEntryIndex: 1 })
  })

  it('flags an unterminated quote in args', () => {
    const issues = validateDraftLocally(
      { kind: 'new' },
      draftWith({ label: 'Work', args: '--model "gpt' })
    )
    expect(issues.some((i) => i.field === 'args')).toBe(true)
  })

  it('duplicate mode validates only the label and ignores bad args', () => {
    const issues = validateDraftLocally(
      { kind: 'duplicate', sourceAgent: CODEX },
      draftWith({ label: 'Copy', args: '--model "gpt', commandOverride: 'a && b' })
    )
    expect(issues).toEqual([])
  })

  it('repair modes validate every field like a normal custom draft', () => {
    const bad = draftWith({ label: 'Fixed', args: '--model "gpt' })
    expect(
      validateDraftLocally(
        { kind: 'repair-edit', id: CUSTOM_ID, repairToken: 't', baseAgent: CODEX },
        bad
      ).some((i) => i.field === 'args')
    ).toBe(true)
    expect(
      validateDraftLocally({ kind: 'repair-replace', repairToken: 't' }, bad).some(
        (i) => i.field === 'args'
      )
    ).toBe(true)
  })
})

describe('isBaseSelectableMode', () => {
  it('is true only for the base-authoring modes', () => {
    expect(isBaseSelectableMode({ kind: 'new' })).toBe(true)
    expect(isBaseSelectableMode({ kind: 'repair-replace', repairToken: 't' })).toBe(true)
    expect(isBaseSelectableMode({ kind: 'edit', id: CUSTOM_ID })).toBe(false)
    expect(
      isBaseSelectableMode({
        kind: 'repair-edit',
        id: CUSTOM_ID,
        repairToken: 't',
        baseAgent: CODEX
      })
    ).toBe(false)
  })
})

describe('built-in-launch mode', () => {
  it('seeds the draft from the settings override maps', () => {
    const draft = builtInDraftFromSettings(CODEX, {
      agentCmdOverrides: { codex: '/opt/codex' },
      agentDefaultArgs: { codex: '--model gpt-5' },
      agentDefaultEnv: { codex: { CODEX_HOME: '/x' } }
    })
    expect(draft).toMatchObject({
      baseAgent: 'codex',
      label: '',
      commandOverride: '/opt/codex',
      args: '--model gpt-5'
    })
    expect(draft.envRows).toEqual([expect.objectContaining({ key: 'CODEX_HOME', value: '/x' })])
  })

  it('seeds blank fields with one env row when no override exists', () => {
    const draft = builtInDraftFromSettings(CODEX, undefined)
    expect(draft).toMatchObject({ commandOverride: '', args: '' })
    expect(draft.envRows).toHaveLength(1)
  })

  it('builds an update-built-in mutation, storing an empty command as no override', () => {
    const mutation = buildMutation(
      { kind: 'built-in-launch', agent: CODEX },
      draftWith({
        commandOverride: '   ',
        args: '--flag',
        envRows: [createEnvRow({ key: 'A', value: 'b' })]
      })
    )
    expect(mutation).toEqual({
      kind: 'update-built-in',
      agent: 'codex',
      changes: { commandOverride: null, args: '--flag', env: { A: 'b' } }
    })
  })

  it('preserves a multi-token wrapper command that the custom one-executable rule rejects', () => {
    const wrapper = 'mise exec -- codex'
    // custom mode would flag this as a shell operator / multi-token; built-in accepts it.
    expect(
      validateDraftLocally(
        { kind: 'built-in-launch', agent: CODEX },
        draftWith({ commandOverride: wrapper })
      )
    ).toEqual([])
    expect(toBuiltInAgentChanges(draftWith({ commandOverride: wrapper })).commandOverride).toBe(
      wrapper
    )
  })

  it('does not impose the v1 args grammar on built-in args', () => {
    // An unterminated quote is a v1-grammar failure that legacy built-in args tolerate.
    expect(
      validateDraftLocally(
        { kind: 'built-in-launch', agent: CODEX },
        draftWith({ args: '--model "gpt' })
      )
    ).toEqual([])
  })

  it('still enforces env safety and hard bounds', () => {
    const issues = validateDraftLocally(
      { kind: 'built-in-launch', agent: CODEX },
      draftWith({ envRows: [createEnvRow({ key: 'ORCA_PANE_KEY', value: 'x' })] })
    )
    expect(issues).toContainEqual({ field: 'env', reason: 'reserved_name', envEntryIndex: 0 })
  })
})

describe('previewArgsTokens', () => {
  it('splits a multiline template into tokens (acceptance 38)', () => {
    const result = previewArgsTokens('--model x\n--safe')
    expect(result).toEqual({ ok: true, tokens: ['--model', 'x', '--safe'] })
  })

  it('reports an unterminated quote as a failure', () => {
    const result = previewArgsTokens('--model "gpt')
    expect(result.ok).toBe(false)
  })
})

describe('resolveMutationErrorFocus', () => {
  function failure(
    over: Partial<Extract<AgentCatalogMutationResult, { ok: false }>>
  ): Extract<AgentCatalogMutationResult, { ok: false }> {
    return { ok: false, code: 'invalid_agent_field', revision: 3, ...over }
  }

  it('focuses the label on a duplicate-label rejection', () => {
    expect(resolveMutationErrorFocus(failure({ code: 'duplicate_agent_label' }))).toEqual({
      field: 'label'
    })
  })

  it('focuses the offending env entry on an invalid-field rejection', () => {
    expect(
      resolveMutationErrorFocus(failure({ field: 'env', reason: 'bounds', envEntryIndex: 2 }))
    ).toEqual({ field: 'env', envEntryIndex: 2 })
  })

  it('does not blame a field on a revision conflict (the dialog reloads and keeps the draft)', () => {
    expect(resolveMutationErrorFocus(failure({ code: 'catalog_revision_conflict' }))).toBeNull()
  })

  it('does not blame a field when the profile is read-only for a newer schema', () => {
    expect(resolveMutationErrorFocus(failure({ code: 'agent_catalog_schema_too_new' }))).toBeNull()
  })
})
