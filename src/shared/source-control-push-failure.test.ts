import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  PUSH_FAILURE_PROMPT_FILE_LIMIT,
  PUSH_FAILURE_SUMMARY_SCAN_CODE_UNITS,
  buildFixPushFailurePrompt,
  hasExpandedPushFailureDetails,
  isPushHookFailure,
  sanitizePushFailureDetails,
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

  it('does not treat protected, pre-receive, non-fast-forward, transport, or submodule failures as push hooks', () => {
    const negatives = [
      'git push failed: Command failed: git push origin main\nremote: error: GH006: Protected branch update failed for refs/heads/main.\nremote: lint status check is required',
      'git push failed: Command failed: git push origin main\nremote: pre-receive hook declined\nremote: eslint failed in hosted checks',
      'git push failed: Command failed: git push origin main\n! [rejected] main -> main (non-fast-forward)\nerror: failed to push some refs',
      'git push failed: Command failed: git push origin main\nfatal: unable to access https://example.com/repo.git: Could not resolve host',
      "git push failed: Command failed: git push --recurse-submodules\nUnable to push submodule 'vendor/lib'\nfatal: failed to push all needed submodules"
    ]

    for (const raw of negatives) {
      expect(isPushHookFailure(raw)).toBe(false)
    }
  })

  it('strips ANSI and control output before details and comparison', () => {
    const raw = '\u001b[31mhusky - pre-push hook failed\u001b[0m\u0007\neslint failed'

    expect(sanitizePushFailureDetails(raw)).toBe('husky - pre-push hook failed\neslint failed')
    expect(summarizePushFailure(raw)).toBe('Lint failed during push.')
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

  it('caps changed files in push prompts and reports the omitted count', () => {
    const entries = Array.from({ length: PUSH_FAILURE_PROMPT_FILE_LIMIT + 3 }, (_, index) => ({
      path: `src/file-${index}.ts`,
      status: 'modified' as const,
      area: 'unstaged' as const
    }))

    const prompt = buildFixPushFailurePrompt({
      summary: 'Lint failed during push.',
      error: 'eslint failed',
      branchName: 'feature/push-hook',
      worktreePath: '/repo/worktree',
      entries
    })

    expect(prompt).toContain(`- Changed files at failure time (${entries.length}):`)
    expect(prompt).toContain('- "src/file-39.ts" (modified, unstaged)')
    expect(prompt).not.toContain('src/file-40.ts')
    expect(prompt).toContain('- ...3 more changed files omitted...')
  })

  it('keeps the useful tail of very long hook output in the prompt', () => {
    const prompt = buildFixPushFailurePrompt({
      summary: 'Pre-push hook failed.',
      error: `${'noise\n'.repeat(4000)}actual lint error near the end`,
      branchName: 'feature/push-hook',
      worktreePath: null,
      entries: []
    })

    expect(prompt).toContain('characters omitted')
    expect(prompt).toContain('actual lint error near the end')
  })
})
