import { useEffect, useState } from 'react'
import { AlertTriangle, ExternalLink } from 'lucide-react'

type PreflightIssue = {
  id: string
  title: string
  description: string
  fixLabel: string
  fixUrl: string
}

export function usePreflightIssues(): PreflightIssue[] {
  const [issues, setIssues] = useState<PreflightIssue[]>([])

  useEffect(() => {
    let cancelled = false

    void window.api.preflight.check().then((status) => {
      if (cancelled) {
        return
      }

      const found: PreflightIssue[] = []

      if (!status.git.installed) {
        found.push({
          id: 'git',
          title: 'Git is not installed',
          description: 'Orca requires Git to manage repositories and worktrees.',
          fixLabel: 'Install Git',
          fixUrl: 'https://git-scm.com/downloads'
        })
      }

      if (!status.gh.installed) {
        found.push({
          id: 'gh',
          title: 'GitHub CLI is not installed',
          description: 'Orca uses the GitHub CLI (gh) to show pull requests, issues, and checks.',
          fixLabel: 'Install GitHub CLI',
          fixUrl: 'https://cli.github.com'
        })
      } else if (!status.gh.authenticated) {
        found.push({
          id: 'gh-auth',
          title: 'GitHub CLI is not authenticated',
          description: 'Run "gh auth login" in a terminal to connect your GitHub account.',
          fixLabel: 'Learn more',
          fixUrl: 'https://cli.github.com/manual/gh_auth_login'
        })
      }

      setIssues(found)
    })

    return () => {
      cancelled = true
    }
  }, [])

  return issues
}

export default function PreflightBanner({
  issues
}: {
  issues: PreflightIssue[]
}): React.JSX.Element | null {
  if (issues.length === 0) {
    return null
  }

  return (
    <div className="w-full rounded-lg border border-yellow-500/30 bg-yellow-500/5 p-4 space-y-3">
      <div className="flex items-center gap-2 text-yellow-500">
        <AlertTriangle className="size-4 shrink-0" />
        <span className="text-sm font-medium">Missing dependencies</span>
      </div>
      <div className="space-y-2.5">
        {issues.map((issue) => (
          <div key={issue.id} className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm font-medium text-foreground">{issue.title}</p>
              <p className="text-xs text-muted-foreground mt-0.5">{issue.description}</p>
            </div>
            <button
              className="inline-flex items-center gap-1 shrink-0 text-xs font-medium text-blue-400 hover:text-blue-300 transition-colors cursor-pointer"
              onClick={() => window.api.shell.openUrl(issue.fixUrl)}
            >
              {issue.fixLabel}
              <ExternalLink className="size-3" />
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}
