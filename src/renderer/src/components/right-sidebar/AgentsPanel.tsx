import React, { useCallback, useEffect, useState } from 'react'
import { RefreshCw, ChevronDown } from 'lucide-react'
import { useAppStore } from '@/store'
import { cn } from '@/lib/utils'
import { detectLanguage } from '@/lib/language-detect'
import { basename } from '@/lib/path'
import { useActiveWorktreePath } from './useActiveWorktreePath'
import { useClaudeConfig } from './useClaudeConfig'

type SectionKey = 'agents' | 'skills' | 'commands' | 'rules' | 'mcpServers'

function SectionHeader({
  label,
  count,
  isCollapsed,
  onToggle
}: {
  label: string
  count: number
  isCollapsed: boolean
  onToggle: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      className="flex flex-1 items-center gap-1 rounded-md px-0.5 py-0.5 text-left text-xs font-semibold uppercase tracking-wider text-foreground/70 hover:bg-accent hover:text-accent-foreground"
      onClick={onToggle}
    >
      <ChevronDown
        className={cn('size-3.5 shrink-0 transition-transform', isCollapsed && '-rotate-90')}
      />
      <span>{label}</span>
      <span className="text-[11px] font-medium tabular-nums">{count}</span>
    </button>
  )
}

function ItemRow({
  name,
  description,
  filePath,
  relativePath,
  worktreeId,
  subtitle
}: {
  name: string
  description: string
  filePath: string
  relativePath: string
  worktreeId: string
  subtitle?: string
}): React.JSX.Element {
  const openFile = useAppStore((s) => s.openFile)

  const handleClick = useCallback(() => {
    openFile(
      {
        filePath,
        relativePath,
        worktreeId,
        language: detectLanguage(basename(filePath)),
        mode: 'edit'
      },
      { preview: true }
    )
  }, [openFile, filePath, relativePath, worktreeId])

  const truncatedDesc = description.length > 80 ? `${description.slice(0, 80)}…` : description

  return (
    <button
      type="button"
      className="flex flex-col w-full text-left px-3 py-1 hover:bg-accent/50 transition-colors cursor-pointer"
      onClick={handleClick}
    >
      <span className="text-[12px] text-foreground leading-snug truncate">{name}</span>
      {(truncatedDesc || subtitle) && (
        <span className="text-[10px] text-muted-foreground leading-snug truncate">
          {subtitle ? `${subtitle}${truncatedDesc ? ' · ' : ''}` : ''}
          {truncatedDesc}
        </span>
      )}
    </button>
  )
}

const SECTIONS: {
  key: SectionKey
  label: string
}[] = [
  { key: 'agents', label: 'Agents' },
  { key: 'skills', label: 'Skills' },
  { key: 'commands', label: 'Commands' },
  { key: 'rules', label: 'Rules' },
  { key: 'mcpServers', label: 'MCP Servers' }
]

export default function AgentsPanel(): React.JSX.Element {
  const activeWorktreeId = useAppStore((s) => s.activeWorktreeId)
  const worktreesByRepo = useAppStore((s) => s.worktreesByRepo)
  const worktreePath = useActiveWorktreePath(activeWorktreeId, worktreesByRepo)
  const { config, loading, hasClaudeDir, scan } = useClaudeConfig(worktreePath)
  const [collapsedSections, setCollapsedSections] = useState<Set<SectionKey>>(new Set())

  useEffect(() => {
    void scan()
  }, [scan])

  const toggleSection = useCallback((key: SectionKey) => {
    setCollapsedSections((prev) => {
      const next = new Set(prev)
      if (next.has(key)) {
        next.delete(key)
      } else {
        next.add(key)
      }
      return next
    })
  }, [])

  if (!worktreePath) {
    return (
      <div className="px-4 py-6">
        <div className="text-sm font-medium text-foreground">No worktree selected</div>
        <div className="mt-1 text-xs text-muted-foreground">
          Select a worktree to view agent configuration
        </div>
      </div>
    )
  }

  if (!loading && !hasClaudeDir) {
    return (
      <div className="px-4 py-6">
        <div className="text-sm font-medium text-foreground">No agent configuration found</div>
        <div className="mt-1 text-xs text-muted-foreground">
          Add a <code className="text-[11px] bg-muted px-1 rounded">.claude/</code> directory to
          this worktree to configure agents, skills, commands, and rules
        </div>
      </div>
    )
  }

  const totalItems =
    config.agents.length +
    config.skills.length +
    config.commands.length +
    config.rules.length +
    config.mcpServers.length

  return (
    <div className="flex-1 overflow-auto scrollbar-sleek">
      <div className="flex items-center justify-between px-3 py-2.5 border-b border-border">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-foreground">
          Agents
          {totalItems > 0 && (
            <span className="ml-1 text-muted-foreground tabular-nums">{totalItems}</span>
          )}
        </span>
        <button
          className="p-1 rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
          title="Refresh"
          onClick={() => void scan()}
          disabled={loading}
        >
          <RefreshCw className={cn('size-3.5', loading && 'animate-spin')} />
        </button>
      </div>

      {loading && totalItems === 0 && (
        <div className="flex items-center justify-center py-8">
          <RefreshCw className="size-4 animate-spin text-muted-foreground" />
        </div>
      )}

      {SECTIONS.map(({ key, label }) => {
        const items = config[key]
        if (items.length === 0) {
          return null
        }

        const isCollapsed = collapsedSections.has(key)

        return (
          <div key={key}>
            <div className="group/section flex items-center pl-1 pr-3 pt-3 pb-1">
              <SectionHeader
                label={label}
                count={items.length}
                isCollapsed={isCollapsed}
                onToggle={() => toggleSection(key)}
              />
            </div>
            {!isCollapsed && (
              <div className="flex flex-col">
                {items.map((item) => (
                  <ItemRow
                    key={item.filePath}
                    name={item.name}
                    description={item.description}
                    filePath={item.filePath}
                    relativePath={item.relativePath}
                    worktreeId={activeWorktreeId!}
                    subtitle={
                      key === 'agents'
                        ? (item as (typeof config.agents)[number]).model
                        : key === 'mcpServers'
                          ? (item as (typeof config.mcpServers)[number]).type?.toUpperCase()
                          : undefined
                    }
                  />
                ))}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
