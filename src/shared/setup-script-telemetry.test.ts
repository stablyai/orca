import { describe, expect, it } from 'vitest'
import {
  buildSetupScriptPromptActionTelemetry,
  buildSetupScriptPromptTelemetry
} from './setup-script-telemetry'
import type { SetupScriptImportCandidate } from './setup-script-imports'

describe('setup script telemetry payload builders', () => {
  it('builds configure prompt telemetry without provider or raw details', () => {
    expect(buildSetupScriptPromptTelemetry({ candidate: null, hasSharedHooks: true })).toEqual({
      mode: 'configure_needed',
      file_count_bucket: '0',
      unsupported_field_count_bucket: '0',
      has_shared_hooks: true
    })
  })

  it('buckets candidate prompt counts and preserves only the provider enum', () => {
    const candidate: SetupScriptImportCandidate = {
      provider: 'codex',
      label: 'Codex',
      files: ['one', 'two', 'three'],
      setup: 'npm install',
      unsupportedFields: ['a', 'b', 'c', 'd']
    }

    expect(buildSetupScriptPromptTelemetry({ candidate, hasSharedHooks: false })).toEqual({
      mode: 'import_available',
      provider: 'codex',
      file_count_bucket: '2-3',
      unsupported_field_count_bucket: '4+',
      has_shared_hooks: false
    })
  })

  it('adds the action without changing the bucketed context', () => {
    const candidate: SetupScriptImportCandidate = {
      provider: 'conductor',
      label: 'Conductor',
      files: ['conductor.json'],
      setup: 'pnpm install'
    }

    expect(
      buildSetupScriptPromptActionTelemetry({
        action: 'import_completed',
        candidate,
        hasSharedHooks: true
      })
    ).toEqual({
      action: 'import_completed',
      mode: 'import_available',
      provider: 'conductor',
      file_count_bucket: '1',
      unsupported_field_count_bucket: '0',
      has_shared_hooks: true
    })
  })

  it('builds configure action telemetry for the no-candidate state', () => {
    expect(
      buildSetupScriptPromptActionTelemetry({
        action: 'configure_clicked',
        candidate: null,
        hasSharedHooks: false
      })
    ).toEqual({
      action: 'configure_clicked',
      mode: 'configure_needed',
      file_count_bucket: '0',
      unsupported_field_count_bucket: '0',
      has_shared_hooks: false
    })
  })

  it('records whether package-manager setup was edited before save', () => {
    const candidate: SetupScriptImportCandidate = {
      provider: 'package-manager',
      label: 'Node.js',
      files: ['package.json'],
      setup: 'npm install'
    }

    expect(
      buildSetupScriptPromptActionTelemetry({
        action: 'save_detected_setup_completed',
        candidate,
        hasSharedHooks: false,
        editedBeforeSave: true
      })
    ).toEqual({
      action: 'save_detected_setup_completed',
      mode: 'import_available',
      provider: 'package-manager',
      file_count_bucket: '1',
      unsupported_field_count_bucket: '0',
      has_shared_hooks: false,
      edited_before_save: true
    })
  })
})
