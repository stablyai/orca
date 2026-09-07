/**
 * Path-only heuristic for "was this file written by a tool?", used to carve
 * machine-authored lines out of the branch total. A regenerated lockfile or
 * protobuf stub can dwarf every hand-written line in a branch, which is what
 * makes a bare `+8,259` misleading.
 *
 * Conservative on purpose: a false positive understates the real work, so only
 * names that are unambiguous across ecosystems are listed. Matched against the
 * raw path with anchored regexes, for the reasons in `test-code-path.ts`.
 */

// Deliberately excludes `build`, `target`, `out` and `bin` — all common as
// hand-written source directories.
const GENERATED_DIRECTORY =
  /(?:^|[/\\])(?:__generated__|__pycache__|\.next|\.nuxt|coverage|dist|generated|node_modules|vendor)[/\\]/i

// Every dependency lockfile is regenerated wholesale, so its diff is churn
// rather than authored change. Kept separate from the suffix alternation below
// rather than merged into it: measured over 12.5k paths, two narrow anchored
// regexes reject a non-match faster than one wide alternation.
const LOCKFILE =
  /(?:^|[/\\])(?:bun\.lockb?|cargo\.lock|composer\.lock|flake\.lock|gemfile\.lock|go\.sum|gradle\.lockfile|mix\.lock|npm-shrinkwrap\.json|package-lock\.json|packages\.lock\.json|pipfile\.lock|pnpm-lock\.yaml|poetry\.lock|pubspec\.lock|uv\.lock|yarn\.lock)$/i

// The suffixes tools stamp onto their own output.
const GENERATED_BASENAME = new RegExp(
  `(?:${[
    /\.(?:generated|designer)\.[^./\\]+/, // Foo.generated.ts, Form.Designer.cs
    // Trailing segments are optional so plugin output keeps matching:
    // service.pb.go, service_pb2.py, service.pb.gw.go, service.pb.validate.go.
    /[._](?:pb|pb2|pb2_grpc)\.(?:[^./\\]+\.)*[^./\\]+/,
    /[._]gen\.[^./\\]+/, // schema.gen.ts, mock_gen.go
    /_generated\.[^./\\]+/, // bindings_generated.go
    /\.(?:g|freezed)\.dart/, // model.g.dart
    /\.min\.(?:js|css|mjs)/,
    /\.(?:js|css|mjs)\.map/, // source maps
    /\.snap/ // vitest/jest snapshots, rewritten by `-u`
  ]
    .map((pattern) => pattern.source)
    .join('|')})$`,
  'i'
)

/** Accepts POSIX and Windows separators — git reports `/`, callers may not. */
export function isGeneratedCodePath(filePath: string): boolean {
  return (
    GENERATED_BASENAME.test(filePath) ||
    LOCKFILE.test(filePath) ||
    GENERATED_DIRECTORY.test(filePath)
  )
}
