import { describe, expect, it } from 'vitest'
import { eventSchemas, setupScriptImportProviderSchema } from './telemetry-events'

describe('setup script prompt schemas', () => {
  it('accepts a bucketed candidate prompt exposure', () => {
    const parsed = eventSchemas.setup_script_prompt_shown.safeParse({
      mode: 'import_available',
      provider: 'codex',
      file_count_bucket: '1',
      unsupported_field_count_bucket: '2-3',
      has_shared_hooks: false
    })
    expect(parsed.success).toBe(true)
  })

  it('accepts configure prompt actions without a provider', () => {
    const parsed = eventSchemas.setup_script_prompt_action.safeParse({
      action: 'configure_clicked',
      mode: 'configure_needed',
      file_count_bucket: '0',
      unsupported_field_count_bucket: '0',
      has_shared_hooks: true
    })
    expect(parsed.success).toBe(true)
  })

  it.each([
    'save_detected_setup_clicked',
    'save_detected_setup_completed',
    'save_detected_setup_failed'
  ])('accepts %s detected setup save actions', (action) => {
    const parsed = eventSchemas.setup_script_prompt_action.safeParse({
      action,
      mode: 'import_available',
      provider: 'package-manager',
      file_count_bucket: '2-3',
      unsupported_field_count_bucket: '0',
      has_shared_hooks: false,
      edited_before_save: true
    })
    expect(parsed.success).toBe(true)
  })

  it('rejects detected setup save actions without edit state', () => {
    const parsed = eventSchemas.setup_script_prompt_action.safeParse({
      action: 'save_detected_setup_completed',
      mode: 'import_available',
      provider: 'package-manager',
      file_count_bucket: '2-3',
      unsupported_field_count_bucket: '0',
      has_shared_hooks: false
    })
    expect(parsed.success).toBe(false)
  })

  it('rejects detected setup save actions for non-package-manager imports', () => {
    const parsed = eventSchemas.setup_script_prompt_action.safeParse({
      action: 'save_detected_setup_completed',
      mode: 'import_available',
      provider: 'codex',
      file_count_bucket: '1',
      unsupported_field_count_bucket: '0',
      has_shared_hooks: false,
      edited_before_save: false
    })
    expect(parsed.success).toBe(false)
  })

  it('rejects unknown setup import providers', () => {
    const parsed = eventSchemas.setup_script_prompt_shown.safeParse({
      mode: 'import_available',
      provider: 'made_up_tool',
      file_count_bucket: '1',
      unsupported_field_count_bucket: '0',
      has_shared_hooks: false
    })
    expect(parsed.success).toBe(false)
  })

  it('rejects candidate prompt exposure without a provider', () => {
    const parsed = eventSchemas.setup_script_prompt_shown.safeParse({
      mode: 'import_available',
      file_count_bucket: '1',
      unsupported_field_count_bucket: '0',
      has_shared_hooks: false
    })
    expect(parsed.success).toBe(false)
  })

  it('rejects configure prompt actions with a provider', () => {
    const parsed = eventSchemas.setup_script_prompt_action.safeParse({
      action: 'configure_clicked',
      mode: 'configure_needed',
      provider: 'codex',
      file_count_bucket: '0',
      unsupported_field_count_bucket: '0',
      has_shared_hooks: false
    })
    expect(parsed.success).toBe(false)
  })

  it('rejects edit state on non-save actions', () => {
    const parsed = eventSchemas.setup_script_prompt_action.safeParse({
      action: 'configure_clicked',
      mode: 'configure_needed',
      file_count_bucket: '0',
      unsupported_field_count_bucket: '0',
      has_shared_hooks: false,
      edited_before_save: true
    })
    expect(parsed.success).toBe(false)
  })

  it('rejects raw setup import details via .strict()', () => {
    const parsed = eventSchemas.setup_script_prompt_action.safeParse({
      action: 'import_completed',
      mode: 'import_available',
      provider: 'codex',
      file_count_bucket: '1',
      unsupported_field_count_bucket: '0',
      has_shared_hooks: false,
      files: ['.codex/environments/environment.toml'],
      setup: 'npm install'
    })
    expect(parsed.success).toBe(false)
  })

  it('rejects unknown setup prompt actions', () => {
    const parsed = eventSchemas.setup_script_prompt_action.safeParse({
      action: 'save_detected_setup_cancelled',
      mode: 'configure_needed',
      file_count_bucket: '0',
      unsupported_field_count_bucket: '0',
      has_shared_hooks: false
    })
    expect(parsed.success).toBe(false)
  })

  it('rejects legacy generation setup action names', () => {
    const parsed = eventSchemas.setup_script_prompt_action.safeParse({
      action: 'generate_setup_clicked',
      mode: 'import_available',
      provider: 'package-manager',
      file_count_bucket: '2-3',
      unsupported_field_count_bucket: '0',
      has_shared_hooks: false,
      edited_before_save: false
    })
    expect(parsed.success).toBe(false)
  })

  it('keeps the provider schema in sync with known setup import providers', () => {
    expect(setupScriptImportProviderSchema.options).toEqual([
      'superset',
      'conductor',
      'codex',
      'cmux',
      'package-manager'
    ])
  })
})
