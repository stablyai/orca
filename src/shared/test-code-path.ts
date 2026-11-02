// Conservative path-only test classification for branch line totals; avoid per-file normalization.

// Match directory segments, not filenames. Keep specs/ excluded (usually production specifications); test basenames still match there.
const TEST_DIRECTORY =
  /(?:^|[/\\])(?:__mocks__|__snapshots__|__tests__|cypress|e2e|spec|tests?|testdata)[/\\]/i

// Keep matches inside basenames; combine ecosystem patterns so V8 scans each path once.
const TEST_BASENAME = new RegExp(
  `(?:${[
    /\.(?:test|spec)\.[^./\\]+/, // Chip.test.tsx, git-status.spec.js
    /[-_](?:test|spec)s?\.[^./\\]+/, // handler_test.go, user_spec.rb
    // Restrict test_ to Python or fixtures/pages become tests. test_client.py remains indistinguishable from a pytest module.
    /(?:^|[/\\])test_[^./\\]*\.py/,
    /(?:^|[/\\])conftest\.py/,
    /\.snap/
  ]
    .map((pattern) => pattern.source)
    .join('|')})$`,
  'i'
)

// Use case-sensitive conventional Test/Tests/Spec suffixes or Contest.java/Latest.kt become false positives.
const TEST_TYPE_NAME_SUFFIX = /(?:Test|Tests|Spec)\.(?:java|kt|kts|scala|groovy|cs|swift|php|rb)$/

/** Accepts POSIX and Windows separators — git reports `/`, callers may not. */
export function isTestCodePath(filePath: string): boolean {
  return (
    TEST_DIRECTORY.test(filePath) ||
    TEST_BASENAME.test(filePath) ||
    TEST_TYPE_NAME_SUFFIX.test(filePath)
  )
}
