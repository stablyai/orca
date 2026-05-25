import { describe, expect, it } from 'vitest'
import { eventSchemas, setupScriptImportProviderSchema } from './telemetry-events'

describe('setup script prompt schemas', () => {
  it('accepts a bucketed import prompt exposure', () => {
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

  it('rejects import prompt exposure without a provider', () => {
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

  it('keeps the provider schema in sync with known setup import providers', () => {
    expect(setupScriptImportProviderSchema.options).toEqual([
      'superset',
      'conductor',
      'codex',
      'cmux'
    ])
  })
})
