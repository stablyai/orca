import { describe, expect, it } from 'vitest'
import {
  buildNestedRepoImportActionTelemetry,
  buildNestedRepoImportResultTelemetry
} from './nested-repo-telemetry'

const attemptId = '2fbac1e3-5094-45b4-80a6-90281e6e9e09'

describe('nested repo telemetry payloads', () => {
  it('computes all_selected from raw counts before caps are applied', () => {
    const action = buildNestedRepoImportActionTelemetry({
      attemptId,
      surface: 'sidebar',
      runtimeKind: 'local',
      action: 'import_group',
      foundCount: 600,
      selectedCount: 500
    })
    const result = buildNestedRepoImportResultTelemetry({
      attemptId,
      surface: 'sidebar',
      runtimeKind: 'local',
      mode: 'group',
      foundCount: 600,
      selectedCount: 500,
      result: { importedCount: 500, alreadyKnownCount: 0, failedCount: 0, projects: [] }
    })

    expect(action.found_count).toBe(500)
    expect(action.selected_count).toBe(500)
    expect(action.all_selected).toBe(false)
    expect(result.all_selected).toBe(false)
  })
})
