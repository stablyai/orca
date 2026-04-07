import { FolderPlus, GitBranchPlus } from 'lucide-react'
import { useAppStore } from '../../store'
import logo from '../../../../../resources/logo.svg'
import PreflightBanner, { usePreflightIssues } from './PreflightBanner'
import KeyboardShortcuts from './KeyboardShortcuts'

export default function NoReposLanding(): React.JSX.Element {
  const repos = useAppStore((s) => s.repos)
  const addRepo = useAppStore((s) => s.addRepo)
  const openModal = useAppStore((s) => s.openModal)
  const preflightIssues = usePreflightIssues()

  const canCreateWorktree = repos.length > 0

  return (
    <div className="absolute inset-0 flex items-center justify-center bg-background">
      <div className="w-full max-w-lg px-6">
        <div className="flex flex-col items-center gap-4 py-8">
          <div
            className="flex items-center justify-center size-20 rounded-2xl border border-border/80 shadow-lg shadow-black/40"
            style={{ backgroundColor: '#12181e' }}
          >
            <img src={logo} alt="Orca logo" className="size-12" />
          </div>
          <h1 className="text-4xl font-bold text-foreground tracking-tight">ORCA</h1>

          <PreflightBanner issues={preflightIssues} />

          <p className="text-sm text-muted-foreground text-center">
            Add a repository to get started.
          </p>

          <div className="flex items-center justify-center gap-2.5 flex-wrap">
            <button
              className="inline-flex items-center gap-1.5 bg-secondary/70 border border-border/80 text-foreground font-medium text-sm px-4 py-2 rounded-md cursor-pointer hover:bg-accent transition-colors"
              onClick={addRepo}
            >
              <FolderPlus className="size-3.5" />
              Add Repo
            </button>

            <button
              className="inline-flex items-center gap-1.5 bg-secondary/70 border border-border/80 text-foreground font-medium text-sm px-4 py-2 rounded-md transition-colors disabled:opacity-40 disabled:cursor-not-allowed enabled:cursor-pointer enabled:hover:bg-accent"
              disabled={!canCreateWorktree}
              title={!canCreateWorktree ? 'Add a repo first' : undefined}
              onClick={() => openModal('create-worktree')}
            >
              <GitBranchPlus className="size-3.5" />
              Create Worktree
            </button>
          </div>

          <KeyboardShortcuts />
        </div>
      </div>
    </div>
  )
}
