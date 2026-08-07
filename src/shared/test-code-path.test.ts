import { describe, expect, it } from 'vitest'
import { isTestCodePath } from './test-code-path'

describe('isTestCodePath', () => {
  it('recognizes the per-ecosystem filename conventions', () => {
    for (const filePath of [
      'src/renderer/src/components/Chip.test.tsx',
      'src/shared/git-status.spec.js',
      'internal/server/handler_test.go',
      'app/models/user_spec.rb',
      'tools/test_migration.py',
      'src/main/java/com/orca/GitTest.java',
      'src/Orca.Core/GitStatusTests.cs',
      'src/UserTest.kt',
      'AppTests.swift',
      'FooSpec.rb',
      'python/conftest.py',
      'src/components/__snapshots__/Chip.tsx.snap'
    ]) {
      expect(isTestCodePath(filePath), filePath).toBe(true)
    }
  })

  it('recognizes test directories anywhere in the path, on either separator', () => {
    expect(isTestCodePath('src/__tests__/git-status.ts')).toBe(true)
    expect(isTestCodePath('tests/fixtures/repo.json')).toBe(true)
    expect(isTestCodePath('e2e/login.ts')).toBe(true)
    expect(isTestCodePath('src\\__mocks__\\fs.ts')).toBe(true)
  })

  it('matches whole segments, so production paths that merely contain the word do not count', () => {
    for (const filePath of [
      'src/latest/index.ts',
      'src/contest/leaderboard.ts',
      'src/testing-library-setup.ts',
      'docs/protest.md',
      'src/shared/git-status-types.ts',
      // A `specs/` folder is usually specifications, not tests.
      'src/cli/specs/account.ts',
      // Case-insensitive "…test.ext" suffixes hit ordinary type names.
      'src/Contest.java',
      'src/Latest.kt',
      'src/MyContest.php',
      'packages/spec.rb',
      // The `test_` prefix is pytest's; outside Python it hits fixtures and pages.
      'src/pages/test_page.tsx',
      'fixtures/test_data.json'
    ]) {
      expect(isTestCodePath(filePath), filePath).toBe(false)
    }
    // ...but a real test inside one still matches on its basename.
    expect(isTestCodePath('src/cli/specs/account.test.ts')).toBe(true)
    expect(isTestCodePath('spec/models/user_spec.rb')).toBe(true)
  })

  it('handles a bare filename and an empty path without throwing', () => {
    expect(isTestCodePath('chip.test.ts')).toBe(true)
    expect(isTestCodePath('chip.ts')).toBe(false)
    expect(isTestCodePath('')).toBe(false)
  })
})
