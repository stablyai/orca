import React, { useCallback } from 'react'
import { GitFork } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { translate } from '@/i18n/i18n'

export type AgentSessionForkPointOption = {
  id: string
  prompt: string
}

type AgentSessionForkPointMenuProps = {
  paneKey: string
  forkPointOptions: AgentSessionForkPointOption[]
  onForkSession: (paneKey: string, messageId?: string) => void
  children: React.ReactElement
}

function getForkPointLabel(option: AgentSessionForkPointOption, index: number): string {
  const detail = option.prompt.trim() || option.id
  return translate(
    'auto.components.dashboard.AgentSessionForkPointMenu.message',
    'Message {{value0}}: {{value1}}',
    { value0: String(index + 1), value1: detail }
  )
}

export function AgentSessionForkPointMenu({
  paneKey,
  forkPointOptions,
  onForkSession,
  children
}: AgentSessionForkPointMenuProps): React.JSX.Element {
  const handleCurrentEnd = useCallback(() => {
    onForkSession(paneKey)
  }, [onForkSession, paneKey])

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{children}</DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72">
        <DropdownMenuGroup>
          <DropdownMenuItem onSelect={handleCurrentEnd}>
            <GitFork className="size-3.5" />
            <span className="max-w-64 truncate">
              {translate(
                'auto.components.dashboard.AgentSessionForkPointMenu.currentEnd',
                'Current end'
              )}
            </span>
          </DropdownMenuItem>
          {forkPointOptions.map((option, index) => (
            <DropdownMenuItem key={option.id} onSelect={() => onForkSession(paneKey, option.id)}>
              <GitFork className="size-3.5" />
              <span className="max-w-64 truncate">{getForkPointLabel(option, index)}</span>
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
