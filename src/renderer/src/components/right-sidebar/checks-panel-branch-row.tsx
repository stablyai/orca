import type React from 'react'
import { ArrowLeft, GitBranch } from 'lucide-react'

type ChecksPanelBranchRowProps = {
  baseRefName?: string
  headRefName?: string
}

// Why: the sidebar PR panel showed the merge button and checks but never the
// merge target, so reviewers couldn't tell which branch the code lands in.
// Mirrors PullRequestPage's scannable base ← head idiom in a compact form.
export function ChecksPanelBranchRow({
  baseRefName,
  headRefName
}: ChecksPanelBranchRowProps): React.JSX.Element | null {
  if (!baseRefName && !headRefName) {
    return null
  }

  const pillClass =
    'max-w-[45%] truncate rounded border border-border bg-muted/40 px-1.5 py-0.5 font-mono text-[10px] text-foreground'

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1 text-[10px] text-muted-foreground">
      <GitBranch className="size-3 shrink-0 text-muted-foreground/70" />
      {baseRefName ? (
        <span className={pillClass} title={baseRefName}>
          {baseRefName}
        </span>
      ) : null}
      {baseRefName && headRefName ? (
        <ArrowLeft className="size-3 shrink-0 text-muted-foreground/70" />
      ) : null}
      {headRefName ? (
        <span className={pillClass} title={headRefName}>
          {headRefName}
        </span>
      ) : null}
    </div>
  )
}
