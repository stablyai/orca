import { describe, expect, it } from 'vitest'
import { eventSchemas } from './telemetry-events'

const attemptId = '2fbac1e3-5094-45b4-80a6-90281e6e9e09'

describe('nested repo import telemetry schemas', () => {
  it('accepts scan, action, and result telemetry payloads', () => {
    expect(
      eventSchemas.add_repo_nested_scan_result.safeParse({
        attempt_id: attemptId,
        surface: 'onboarding',
        runtime_kind: 'local',
        result: 'review_shown',
        selected_path_kind: 'non_git_folder',
        found_count: 3,
        found_count_bucket: '2-3',
        truncated: false,
        timed_out: false
      }).success
    ).toBe(true)

    expect(
      eventSchemas.add_repo_nested_import_action.safeParse({
        attempt_id: attemptId,
        surface: 'sidebar',
        runtime_kind: 'ssh',
        action: 'import_group',
        found_count: 3,
        found_count_bucket: '2-3',
        selected_count: 3,
        selected_count_bucket: '2-3',
        all_selected: true
      }).success
    ).toBe(true)

    expect(
      eventSchemas.add_repo_nested_import_result.safeParse({
        attempt_id: attemptId,
        surface: 'onboarding',
        runtime_kind: 'runtime',
        mode: 'group',
        outcome: 'success',
        found_count: 3,
        found_count_bucket: '2-3',
        selected_count: 3,
        selected_count_bucket: '2-3',
        imported_count: 3,
        imported_count_bucket: '2-3',
        already_known_count: 0,
        already_known_count_bucket: '0',
        failed_count: 0,
        failed_count_bucket: '0',
        all_selected: true
      }).success
    ).toBe(true)
  })

  it('rejects raw paths, repo names, and raw errors via .strict()', () => {
    expect(
      eventSchemas.add_repo_nested_scan_result.safeParse({
        attempt_id: attemptId,
        surface: 'onboarding',
        runtime_kind: 'local',
        result: 'review_shown',
        selected_path_kind: 'non_git_folder',
        found_count: 1,
        found_count_bucket: '1',
        truncated: false,
        timed_out: false,
        selected_path: '/Users/alice/work/platform'
      }).success
    ).toBe(false)

    expect(
      eventSchemas.add_repo_nested_import_action.safeParse({
        attempt_id: attemptId,
        surface: 'sidebar',
        runtime_kind: 'local',
        action: 'import_group',
        found_count: 1,
        found_count_bucket: '1',
        selected_count: 1,
        selected_count_bucket: '1',
        all_selected: true,
        repo_name: 'secret-service'
      }).success
    ).toBe(false)

    expect(
      eventSchemas.add_repo_nested_import_result.safeParse({
        attempt_id: attemptId,
        surface: 'sidebar',
        runtime_kind: 'ssh',
        mode: 'group',
        outcome: 'failed',
        found_count: 1,
        found_count_bucket: '1',
        selected_count: 1,
        selected_count_bucket: '1',
        imported_count: 0,
        imported_count_bucket: '0',
        already_known_count: 0,
        already_known_count_bucket: '0',
        failed_count: 1,
        failed_count_bucket: '1',
        all_selected: true,
        error_message: 'failed at /Users/alice/work/platform'
      }).success
    ).toBe(false)
  })

  it('rejects unbounded imported counts', () => {
    const parsed = eventSchemas.add_repo_nested_import_result.safeParse({
      attempt_id: attemptId,
      surface: 'onboarding',
      runtime_kind: 'local',
      mode: 'separate',
      outcome: 'success',
      found_count: 501,
      found_count_bucket: '16+',
      selected_count: 501,
      selected_count_bucket: '16+',
      imported_count: 501,
      imported_count_bucket: '16+',
      already_known_count: 0,
      already_known_count_bucket: '0',
      failed_count: 0,
      failed_count_bucket: '0',
      all_selected: true
    })

    expect(parsed.success).toBe(false)
  })

  it('rejects mismatched exact counts and buckets', () => {
    expect(
      eventSchemas.add_repo_nested_import_action.safeParse({
        attempt_id: attemptId,
        surface: 'sidebar',
        runtime_kind: 'local',
        action: 'import_group',
        found_count: 1,
        found_count_bucket: '16+',
        selected_count: 1,
        selected_count_bucket: '1',
        all_selected: true
      }).success
    ).toBe(false)

    expect(
      eventSchemas.add_repo_nested_import_result.safeParse({
        attempt_id: attemptId,
        surface: 'sidebar',
        runtime_kind: 'local',
        mode: 'group',
        outcome: 'success',
        found_count: 2,
        found_count_bucket: '2-3',
        selected_count: 2,
        selected_count_bucket: '2-3',
        imported_count: 2,
        imported_count_bucket: '16+',
        already_known_count: 0,
        already_known_count_bucket: '0',
        failed_count: 0,
        failed_count_bucket: '0',
        all_selected: true
      }).success
    ).toBe(false)
  })
})
