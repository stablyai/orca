import { describe, expect, it } from 'vitest'
import {
  PUSH_FAILURE_PROMPT_FILE_LIMIT,
  buildFixPushFailurePrompt,
  isPushHookFailure,
  summarizePushFailure
} from './source-control-push-failure'

describe('push failure detection and summary', () => {
  it('detects explicit pre-push hook failures', () => {
    const raw =
      "error: failed to push some refs to 'origin'\nhusky - pre-push hook exited with code 1"

    expect(isPushHookFailure(raw)).toBe(true)
    expect(summarizePushFailure(raw)).toBe('Pre-push hook failed.')
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
})

describe('buildFixPushFailurePrompt', () => {
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
