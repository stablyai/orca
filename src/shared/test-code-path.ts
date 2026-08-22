// Path-only test heuristic for branch line-total buckets. Conservative and
// anchored on the raw path (no lowercasing/splitting per file).

// Whole path segments only, so `src/latest/x.ts` and `contest/` don't count.
// The trailing separator is what keeps a *file* named `test.ts` out of here.
// `spec/` is RSpec's; plural `specs/` is left out because it far more often
// holds specifications (this repo's `src/cli/specs/` is production code), and a
// real test inside one still matches on its `.spec.`/`_spec.` basename.
const TEST_DIRECTORY =
  /(?:^|[/\\])(?:__mocks__|__snapshots__|__tests__|cypress|e2e|spec|tests?|testdata)[/\\]/i

// One alternative per ecosystem convention; `[^./\\]` keeps each anchored match
// inside the basename. Joined into a single regex so V8 walks the path once.
const TEST_BASENAME = new RegExp(
  `(?:${[
    /\.(?:test|spec)\.[^./\\]+/, // Chip.test.tsx, git-status.spec.js
    /[-_](?:test|spec)s?\.[^./\\]+/, // handler_test.go, user_spec.rb
    // `.py` only: the bare `test_` prefix is pytest's convention, and widening it
    // to any extension swept in fixtures and pages (test_data.json, test_page.tsx).
    // A production helper that happens to be named `test_client.py` is
    // indistinguishable from a real module here — pytest collects it too.
    /(?:^|[/\\])test_[^./\\]*\.py/,
    /(?:^|[/\\])conftest\.py/,
    /\.snap/
  ]
    .map((pattern) => pattern.source)
    .join('|')})$`,
  'i'
)

// Case-sensitive on purpose: a case-insensitive `test`/`tests`/`spec` suffix
// falsely matches ordinary type names like Contest.java, Latest.kt, MyContest.php.
// JVM/C#/Swift/PHP/Ruby test types use a capital T/S in the conventional suffix.
const TEST_TYPE_NAME_SUFFIX = /(?:Test|Tests|Spec)\.(?:java|kt|kts|scala|groovy|cs|swift|php|rb)$/

/** Accepts POSIX and Windows separators — git reports `/`, callers may not. */
export function isTestCodePath(filePath: string): boolean {
  return (
    TEST_DIRECTORY.test(filePath) ||
    TEST_BASENAME.test(filePath) ||
    TEST_TYPE_NAME_SUFFIX.test(filePath)
  )
}
