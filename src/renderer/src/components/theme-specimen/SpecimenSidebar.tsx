import { Badge } from '@/components/ui/badge'

const PROJECTS = [
  { name: 'aurora-app', branch: 'feature/welcome-back', host: 'Local', active: true },
  { name: 'api-gateway', branch: 'main', host: 'SSH', active: false },
  { name: 'docs-site', branch: 'docs/themes', host: null, active: false }
]

const CHANGES: [string, string, string][] = [
  ['greet.ts', 'M', '--git-decoration-modified'],
  ['time.ts', 'A', '--git-decoration-added'],
  ['legacy.ts', 'D', '--git-decoration-deleted'],
  ['notes.md', 'U', '--git-decoration-untracked'],
  ['old-name.ts', 'R', '--git-decoration-renamed']
]

/** The workspace sidebar: cards (one selected), host badges and git decoration colors. */
export function SpecimenSidebar(): React.JSX.Element {
  return (
    <div
      className="flex w-[24%] shrink-0 flex-col gap-1 border-r p-2 text-[13px]"
      style={{
        background: 'var(--worktree-sidebar)',
        color: 'var(--worktree-sidebar-foreground)',
        borderColor: 'var(--worktree-sidebar-border)'
      }}
    >
      <div className="px-2 pt-1 pb-1 text-[11px] font-medium tracking-wide uppercase opacity-70">
        Projects
      </div>
      {PROJECTS.map((project) => (
        <div
          key={project.name}
          className="rounded-lg px-2.5 py-2"
          style={project.active ? { background: 'var(--worktree-sidebar-active)' } : undefined}
        >
          <div className="font-medium">{project.name}</div>
          <div className="mt-0.5 flex items-center gap-1.5 text-[12px]">
            {project.host ? <Badge variant="hostContext">{project.host}</Badge> : null}
            <span className="truncate opacity-70">{project.branch}</span>
          </div>
        </div>
      ))}
      <div className="px-2 pt-3 pb-1 text-[11px] font-medium tracking-wide uppercase opacity-70">
        Changes
      </div>
      {CHANGES.map(([file, mark, token]) => (
        <div
          key={file}
          className="flex justify-between px-2 py-0.5"
          style={{ color: `var(${token})` }}
        >
          <span>{file}</span>
          <span>{mark}</span>
        </div>
      ))}
    </div>
  )
}
