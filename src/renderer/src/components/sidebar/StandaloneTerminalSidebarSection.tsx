import { useState } from 'react'
import { Pencil, Plus, SquareTerminal } from 'lucide-react'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import { useAppStore } from '@/store'

const EMPTY_TERMINAL_TABS: readonly TerminalTab[] = []

type StandaloneTerminalSidebarSectionProps = {
  onActivateTerminal: (tabId: string) => void
  onCreateTerminal: () => void
}

function getTerminalLabel(tab: TerminalTab, index: number): string {
  return (
    tab.customTitle?.trim() ||
    tab.defaultTitle?.trim() ||
    tab.title.trim() ||
    translate(
      'auto.components.sidebar.StandaloneTerminalSidebarSection.terminalNumber',
      'Terminal {{number}}',
      {
        number: index + 1
      }
    )
  )
}

export function StandaloneTerminalSidebarSection({
  onActivateTerminal,
  onCreateTerminal
}: StandaloneTerminalSidebarSectionProps): React.JSX.Element {
  const tabs = useAppStore(
    (state) => state.tabsByWorktree[FLOATING_TERMINAL_WORKTREE_ID] ?? EMPTY_TERMINAL_TABS
  )
  const activeWorktreeId = useAppStore((state) => state.activeWorktreeId)
  const activeTabId = useAppStore(
    (state) => state.activeTabIdByWorktree[FLOATING_TERMINAL_WORKTREE_ID] ?? null
  )
  const setTabCustomTitle = useAppStore((state) => state.setTabCustomTitle)
  const [renamingTabId, setRenamingTabId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const newTerminalLabel = translate(
    'auto.components.sidebar.StandaloneTerminalSidebarSection.newTerminal',
    'New terminal'
  )

  const beginRename = (tab: TerminalTab, index: number): void => {
    setRenamingTabId(tab.id)
    setRenameValue(getTerminalLabel(tab, index))
  }

  const commitRename = (tabId: string): void => {
    const title = renameValue.trim()
    setTabCustomTitle(tabId, title.length > 0 ? title : null)
    setRenamingTabId(null)
  }

  return (
    <section
      data-standalone-terminal-section
      className="mx-2 shrink-0 border-t border-worktree-sidebar-border/70 py-1.5"
    >
      <div className="flex h-7 items-center justify-between px-1">
        <button
          type="button"
          className="min-w-0 truncate text-xs font-semibold text-muted-foreground/80 hover:text-foreground"
          onClick={() => {
            const target = tabs.find((tab) => tab.id === activeTabId) ?? tabs.at(-1)
            if (target) {
              onActivateTerminal(target.id)
            } else {
              onCreateTerminal()
            }
          }}
        >
          {translate(
            'auto.components.sidebar.StandaloneTerminalSidebarSection.terminals',
            'Terminals'
          )}
        </button>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              data-standalone-terminal-create
              variant="ghost"
              size="icon-xs"
              className="text-muted-foreground"
              aria-label={newTerminalLabel}
              onClick={onCreateTerminal}
            >
              <Plus className="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="right" sideOffset={6}>
            {newTerminalLabel}
          </TooltipContent>
        </Tooltip>
      </div>

      {tabs.length === 0 ? (
        <button
          type="button"
          className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] text-worktree-sidebar-foreground/50 hover:bg-worktree-sidebar-foreground/8"
          onClick={onCreateTerminal}
        >
          <SquareTerminal className="size-4 shrink-0 opacity-50" strokeWidth={1.75} />
          {newTerminalLabel}
        </button>
      ) : (
        <div
          role="list"
          aria-label={translate(
            'auto.components.sidebar.StandaloneTerminalSidebarSection.terminalList',
            'Terminal list'
          )}
          className="worktree-sidebar-scrollbar max-h-40 overflow-y-auto"
        >
          {tabs.map((tab, index) => {
            const label = getTerminalLabel(tab, index)
            const active =
              activeWorktreeId === FLOATING_TERMINAL_WORKTREE_ID && activeTabId === tab.id
            const renaming = renamingTabId === tab.id
            return (
              <div
                key={tab.id}
                role="listitem"
                className={cn(
                  'group flex items-center gap-1 rounded-md px-1 py-0.5',
                  active && 'bg-worktree-sidebar-accent text-worktree-sidebar-accent-foreground'
                )}
              >
                {renaming ? (
                  <div className="flex min-w-0 flex-1 items-center gap-2 rounded px-1 py-1">
                    <SquareTerminal
                      className={cn('size-4 shrink-0', !active && 'opacity-50')}
                      strokeWidth={active ? 2.25 : 1.75}
                    />
                    <Input
                      autoFocus
                      data-standalone-terminal-rename-input
                      value={renameValue}
                      className="h-6 min-w-0 px-1.5 py-0 text-xs"
                      aria-label={translate(
                        'auto.components.sidebar.StandaloneTerminalSidebarSection.renameTerminal',
                        'Rename terminal'
                      )}
                      onChange={(event) => setRenameValue(event.target.value)}
                      onBlur={() => commitRename(tab.id)}
                      onKeyDown={(event) => {
                        event.stopPropagation()
                        if (event.key === 'Enter') {
                          event.currentTarget.blur()
                        } else if (event.key === 'Escape') {
                          setRenamingTabId(null)
                        }
                      }}
                    />
                  </div>
                ) : (
                  <button
                    type="button"
                    data-standalone-terminal-tab={tab.id}
                    aria-current={active ? 'page' : undefined}
                    className={cn(
                      'flex min-w-0 flex-1 items-center gap-2 rounded px-1 py-1 text-left text-[13px] font-medium tracking-tight',
                      !active &&
                        'text-worktree-sidebar-foreground/60 hover:text-worktree-sidebar-foreground'
                    )}
                    onClick={() => onActivateTerminal(tab.id)}
                    onDoubleClick={() => beginRename(tab, index)}
                  >
                    <SquareTerminal
                      className={cn('size-4 shrink-0', !active && 'opacity-50')}
                      strokeWidth={active ? 2.25 : 1.75}
                    />
                    <span className="min-w-0 flex-1 truncate">{label}</span>
                  </button>
                )}
                {!renaming ? (
                  <Button
                    type="button"
                    data-standalone-terminal-rename={tab.id}
                    variant="ghost"
                    size="icon-xs"
                    className="shrink-0 text-muted-foreground opacity-50 hover:opacity-100 focus-visible:opacity-100"
                    aria-label={translate(
                      'auto.components.sidebar.StandaloneTerminalSidebarSection.renameNamedTerminal',
                      'Rename {{name}}',
                      { name: label }
                    )}
                    onClick={() => beginRename(tab, index)}
                  >
                    <Pencil className="size-3" />
                  </Button>
                ) : null}
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}
