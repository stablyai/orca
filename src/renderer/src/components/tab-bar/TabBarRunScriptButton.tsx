import { useMemo, useState } from 'react'
import { ChevronDown, SquareTerminal } from 'lucide-react'
import { useAppStore } from '@/store'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { runQuickCommandInNewTab } from '@/lib/run-quick-command-in-new-tab'
import { getRepoIdFromWorktreeId } from '../../../../shared/worktree-id'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'
import type { TerminalQuickCommand } from '../../../../shared/types'
import type { PackageJsonScript } from '../../../../shared/package-json-scripts'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { useWorktreePackageScripts } from './useWorktreePackageScripts'

type TabBarRunScriptButtonProps = {
  worktreeId: string
  groupId: string
}

export function TabBarRunScriptButton({
  worktreeId,
  groupId
}: TabBarRunScriptButtonProps): React.JSX.Element | null {
  const packageScripts = useWorktreePackageScripts(worktreeId)
  const repos = useAppStore((s) => s.repos)
  const [menuOpen, setMenuOpen] = useState(false)

  // Why: package.json scripts run in the worktree regardless of repo scope, but
  // a real repoId lets the synthetic command carry repo scope for parity with
  // quick commands. Floating terminals have no owning repo.
  const repoId = useMemo(() => {
    if (worktreeId === FLOATING_TERMINAL_WORKTREE_ID) {
      return null
    }
    const candidate = getRepoIdFromWorktreeId(worktreeId)
    return repos.some((r) => r.id === candidate) ? candidate : null
  }, [worktreeId, repos])

  if (!packageScripts || packageScripts.scripts.length === 0) {
    return null
  }

  const handleRun = (script: PackageJsonScript): void => {
    const command: TerminalQuickCommand = {
      id: `package-script-${script.name}`,
      label: script.name,
      action: 'terminal-command',
      command: packageScripts.runCommandFor(script.name),
      appendEnter: true,
      scope: repoId ? { type: 'repo', repoId } : { type: 'global' }
    }
    setMenuOpen(false)
    runQuickCommandInNewTab({ command, worktreeId, groupId })
  }

  const label = translate('auto.components.tab.bar.TabBarRunScriptButton.runScript', 'Run Script')

  return (
    <DropdownMenu
      modal={false}
      open={menuOpen}
      onOpenChange={(next) => {
        setMenuOpen(next)
        if (next) {
          // Why: re-read package.json on open so freshly added/removed scripts
          // show up without waiting for a worktree re-focus.
          packageScripts.refresh()
        }
      }}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="my-auto flex h-7 shrink-0 items-center gap-1 rounded-md px-1.5 text-muted-foreground hover:bg-accent/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              aria-label={label}
            >
              <SquareTerminal className="size-3.5" />
              <span className="text-[12px] font-medium">{label}</span>
              <ChevronDown className="size-3" strokeWidth={2.5} />
            </button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={6}>
          {translate(
            'auto.components.tab.bar.TabBarRunScriptButton.runScriptTooltip',
            'Run a package.json script'
          )}
        </TooltipContent>
      </Tooltip>
      <DropdownMenuContent
        align="end"
        side="bottom"
        sideOffset={6}
        className="scrollbar-sleek max-h-72 w-64 overflow-y-auto"
      >
        {packageScripts.scripts.map((script) => (
          <DropdownMenuItem
            key={script.name}
            onSelect={() => handleRun(script)}
            className="flex flex-col items-start gap-0.5"
          >
            <span className="max-w-full truncate font-medium">{script.name}</span>
            <span className={cn('max-w-full truncate text-[11px] text-muted-foreground')}>
              {script.command}
            </span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
