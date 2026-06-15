import React, { useEffect, useState } from 'react'
import { SlashSquare } from 'lucide-react'

export type SlashCommandEntry = { name: string; description: string; source: string }

export function useSlashCommands(cwd: string | null): SlashCommandEntry[] {
  const [commands, setCommands] = useState<SlashCommandEntry[]>([])
  useEffect(() => {
    if (!cwd) {
      setCommands([])
      return
    }
    let cancelled = false
    void window.api.claudeChat
      .listCommands({ cwd })
      .then((cmds) => {
        if (!cancelled) {
          setCommands(cmds)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setCommands([])
        }
      })
    return () => {
      cancelled = true
    }
  }, [cwd])
  return commands
}

export function filterSlashCommands(
  commands: SlashCommandEntry[],
  query: string
): SlashCommandEntry[] {
  const q = query.toLowerCase()
  return commands.filter((c) => c.name.toLowerCase().includes(q)).slice(0, 8)
}

type Props = {
  matches: SlashCommandEntry[]
  onPick: (name: string) => void
}

export function ChatSlashMenu({ matches, onPick }: Props): React.JSX.Element | null {
  if (matches.length === 0) {
    return null
  }
  return (
    <div className="rounded-md border border-border bg-popover shadow-md overflow-hidden">
      {matches.map((cmd, i) => (
        <button
          key={cmd.name}
          type="button"
          // Why: onMouseDown so the pick happens before the textarea loses focus.
          onMouseDown={(e) => {
            e.preventDefault()
            onPick(cmd.name)
          }}
          className={`flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs hover:bg-accent transition-colors ${
            i === 0 ? 'bg-accent/50' : ''
          }`}
        >
          <SlashSquare size={12} className="shrink-0 text-muted-foreground" />
          <span className="font-mono font-medium shrink-0">/{cmd.name}</span>
          <span className="text-muted-foreground truncate">{cmd.description}</span>
          <span className="ml-auto shrink-0 text-[10px] text-muted-foreground/60">
            {cmd.source}
          </span>
        </button>
      ))}
    </div>
  )
}
