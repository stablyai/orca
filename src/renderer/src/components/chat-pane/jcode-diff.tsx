// Why: jcode tool results sometimes carry a unified diff (file edits, `git diff`
// output). Orca's editor diff viewer is CodeMirror-bound and tightly coupled to
// the editor lifecycle, so for the lightweight chat-bubble view we render a
// self-contained colorized unified diff — the same approach the proven
// jcode-desktop prototype uses (src/app.js `colorDiff`), adapted to orca's
// Tailwind theme tokens.
import { cn } from '@/lib/utils'

/** Heuristic: does this string look like a unified diff we should render as one?
 *  Requires a hunk header plus at least one +/- body line so plain prose with a
 *  stray leading '-' is not mistaken for a diff. */
export function looksLikeUnifiedDiff(text: string): boolean {
  if (!text) {
    return false
  }
  const hasHunk = /^@@ .* @@/m.test(text) || /^diff --git /m.test(text)
  const hasChange = /^[+-]/m.test(text)
  return hasHunk && hasChange
}

type DiffLineKind = 'add' | 'del' | 'hunk' | 'meta' | 'ctx'

function classifyLine(line: string): DiffLineKind {
  if (line.startsWith('@@')) {
    return 'hunk'
  }
  if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff --git')) {
    return 'meta'
  }
  if (line.startsWith('+')) {
    return 'add'
  }
  if (line.startsWith('-')) {
    return 'del'
  }
  return 'ctx'
}

export function UnifiedDiff({ text }: { text: string }): React.JSX.Element {
  const lines = text.replace(/\n$/, '').split('\n')
  return (
    <pre className="overflow-x-auto rounded-md bg-background/60 p-2 font-mono text-xs leading-relaxed">
      {lines.map((line, index) => {
        const kind = classifyLine(line)
        return (
          <div
            // eslint-disable-next-line react/no-array-index-key -- Why: diff lines have no stable id; order is fixed for a given static diff string.
            key={index}
            className={cn(
              'whitespace-pre',
              kind === 'add' && 'bg-green-500/15 text-green-600 dark:text-green-400',
              kind === 'del' && 'bg-red-500/15 text-red-600 dark:text-red-400',
              kind === 'hunk' && 'text-primary',
              kind === 'meta' && 'text-muted-foreground'
            )}
          >
            {line === '' ? ' ' : line}
          </div>
        )
      })}
    </pre>
  )
}
