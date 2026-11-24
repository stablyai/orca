/** Conservative path-only heuristic separating regenerated churn from authored branch totals; false positives understate work.
 * Use anchored raw-path regexes as in test-code-path.ts. */

// Exclude build/target/out/bin: they commonly contain authored source.
const GENERATED_DIRECTORY =
  /(?:^|[/\\])(?:__generated__|__pycache__|\.next|\.nuxt|coverage|dist|generated|node_modules|vendor)[/\\]/i

// Lockfiles regenerate wholesale. Two narrow anchored regexes reject nonmatches faster than one wide alternation (12.5k-path measurement).
const LOCKFILE =
  /(?:^|[/\\])(?:bun\.lockb?|cargo\.lock|composer\.lock|flake\.lock|gemfile\.lock|go\.sum|gradle\.lockfile|mix\.lock|npm-shrinkwrap\.json|package-lock\.json|packages\.lock\.json|pipfile\.lock|pnpm-lock\.yaml|poetry\.lock|pubspec\.lock|uv\.lock|yarn\.lock)$/i

const GENERATED_BASENAME = new RegExp(
  `(?:${[
    /\.(?:generated|designer)\.[^./\\]+/, // Foo.generated.ts, Form.Designer.cs
    // Allow plugin suffix segments such as service.pb.gw.go and service.pb.validate.go.
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
