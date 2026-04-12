import React, { useState } from 'react'
import { ChevronDown, Play, Square } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import type { RunningScript } from './script-runner-types'

type ScriptRunnerControlsProps = {
  scriptNames: string[]
  selectedScript: string | null
  setSelectedScript: (name: string) => void
  currentCommand: string
  isRunning: boolean
  runningScripts: RunningScript[]
  onRun: () => void
  onStop: (scriptId: number) => void
  onCommandOverride: (scriptName: string, command: string) => void
}

export function ScriptRunnerControls({
  scriptNames,
  selectedScript,
  setSelectedScript,
  currentCommand,
  isRunning,
  runningScripts,
  onRun,
  onStop,
  onCommandOverride
}: ScriptRunnerControlsProps): React.JSX.Element {
  const [editingCommand, setEditingCommand] = useState<string | null>(null)

  return (
    <div className="flex shrink-0 items-center gap-1.5 px-2 pb-2">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button className="flex items-center gap-1.5 rounded-md border border-border/50 bg-secondary/50 px-2 py-1 text-[11px] font-medium text-foreground transition-colors hover:bg-secondary">
            {isRunning && <span className="size-1.5 rounded-full bg-emerald-500 shrink-0" />}
            <span className="max-w-[60px] truncate">{selectedScript ?? 'Select'}</span>
            <ChevronDown className="size-3 text-muted-foreground shrink-0" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="bottom" align="start" className="w-44">
          {scriptNames.map((name) => {
            const running = runningScripts.some((s) => s.name === name && !s.exited)
            return (
              <DropdownMenuItem
                key={name}
                onClick={() => setSelectedScript(name)}
                className="gap-2 text-[11px]"
              >
                {running ? (
                  <span className="size-1.5 rounded-full bg-emerald-500 shrink-0" />
                ) : (
                  <span className="size-1.5 shrink-0" />
                )}
                <span className="truncate">{name}</span>
              </DropdownMenuItem>
            )
          })}
        </DropdownMenuContent>
      </DropdownMenu>

      <input
        type="text"
        value={editingCommand ?? currentCommand}
        onChange={(e) => setEditingCommand(e.target.value)}
        onFocus={(e) => setEditingCommand(e.target.value)}
        onBlur={() => {
          if (editingCommand !== null && selectedScript) {
            onCommandOverride(selectedScript, editingCommand)
          }
          setEditingCommand(null)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            if (editingCommand !== null && selectedScript) {
              onCommandOverride(selectedScript, editingCommand)
            }
            setEditingCommand(null)
            ;(e.target as HTMLInputElement).blur()
          } else if (e.key === 'Escape') {
            setEditingCommand(null)
            ;(e.target as HTMLInputElement).blur()
          }
        }}
        className="h-6 min-w-0 flex-1 rounded-md border border-border/50 bg-background/50 px-2 font-mono text-[10px] text-muted-foreground outline-none transition-colors focus:border-ring focus:text-foreground"
        spellCheck={false}
      />

      {isRunning ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              className="size-6 shrink-0 text-red-500 hover:text-red-400"
              onClick={() => {
                const script = runningScripts.find((s) => s.name === selectedScript && !s.exited)
                if (script) {
                  onStop(script.id)
                }
              }}
            >
              <Square className="size-3 fill-current" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top" sideOffset={4}>
            Stop {selectedScript}
          </TooltipContent>
        </Tooltip>
      ) : (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              className="size-6 shrink-0 text-emerald-500 hover:text-emerald-400 disabled:opacity-30"
              onClick={onRun}
              disabled={!selectedScript}
            >
              <Play className="size-3 fill-current" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top" sideOffset={4}>
            Run {currentCommand}
          </TooltipContent>
        </Tooltip>
      )}
    </div>
  )
}
