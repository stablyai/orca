import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  PUSH_FAILURE_SUMMARY_SCAN_CODE_UNITS,
  buildFixPushFailurePrompt,
  hasExpandedPushFailureDetails,
  isPushHookFailure,
  summarizePushFailure
} from './source-control-push-failure'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('push failure detection and summary', () => {
  it('detects explicit pre-push hook failures', () => {
    const raw =
      "error: failed to push some refs to 'origin'\nhusky - pre-push hook exited with code 1"

    expect(isPushHookFailure(raw)).toBe(true)
    expect(summarizePushFailure(raw)).toBe('Pre-push hook failed.')
  })

  it('detects lint failures during push', () => {
    const raw = [
      'git push failed: Command failed: git push origin main',
      'error: failed to push some refs to origin',
      'eslint found 3 errors'
    ].join('\n')

    expect(isPushHookFailure(raw)).toBe(true)
    expect(summarizePushFailure(raw)).toBe('Lint failed during push.')
  })

  it('does not treat auth failures as push hook failures', () => {
    const raw =
      'git push failed: Command failed: git push origin main\nremote: Repository not found.\nfatal: Authentication failed'

    expect(isPushHookFailure(raw)).toBe(false)
  })

  it('ignores low-signal husky notices without hook failure output', () => {
    const raw =
      "remote: error: failed to push some refs to 'origin'\ngit push\nhusky - deprecated husky@4"

    expect(isPushHookFailure(raw)).toBe(false)
  })

  it('reports whether expanded details add information beyond the summary', () => {
    expect(
      hasExpandedPushFailureDetails(
        'husky - pre-push hook\neslint found 2 errors\nfull output',
        'Lint failed during push.'
      )
    ).toBe(true)
    expect(hasExpandedPushFailureDetails('', 'Push failed.')).toBe(false)
  })

  it('bounds summary analysis for pathological single-line logs', () => {
    const split = vi.spyOn(String.prototype, 'split')
    const raw = 'x'.repeat(PUSH_FAILURE_SUMMARY_SCAN_CODE_UNITS + 10_000)

    expect(summarizePushFailure(raw)).toBe('x'.repeat(PUSH_FAILURE_SUMMARY_SCAN_CODE_UNITS))
    expect(hasExpandedPushFailureDetails(raw, 'Push failed.')).toBe(true)
    expect(split).not.toHaveBeenCalled()
  })
})

describe('buildFixPushFailurePrompt', () => {
  it('builds a provider-neutral AI prompt for fixing a failed push hook', () => {
    const prompt = buildFixPushFailurePrompt({
      summary: 'Lint failed during push.',
      error: 'oxlint found 2 errors\nhusky - pre-push script failed',
      branchName: 'feature/push-hook',
      worktreePath: '/repo/worktree',
      entries: [{ path: 'src/app.ts', status: 'modified', area: 'staged' }]
    })

    expect(prompt).toContain('Fix the failed git push in this worktree')
    expect(prompt).toContain('- Branch: "feature/push-hook"')
    expect(prompt).toContain('- Failure summary: "Lint failed during push."')
    expect(prompt).toContain('- "src/app.ts" (modified, staged)')
    expect(prompt).toContain('Do not bypass hooks with --no-verify')
    expect(prompt).toContain('Do not push, create a pull request')
    expect(prompt).toContain('oxlint found 2 errors')
  })
})
