/** The name people know a ref by: `refs/remotes/origin/main` → `origin/main`, `refs/heads/dev` →
 *  `dev`. Anything else (a bare name or a commit) is shown as is. */
export function shortRefLabel(ref: string): string {
  for (const prefix of ['refs/remotes/', 'refs/heads/', 'refs/tags/']) {
    if (ref.startsWith(prefix) && ref.length > prefix.length) {
      return ref.slice(prefix.length)
    }
  }
  return ref
}
