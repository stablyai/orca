// The Generate field's agent glyph: a menu of the image agents found, shown when there are two or more.
import React from 'react'
import { Check } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { AgentIcon } from '@/components/agent/icons/AgentIcon'
import { AgentIconLabel } from '@/components/agent/agent-combobox-items'
import { useTranslate } from '@/i18n/use-translate'
import { getAgentLabel } from '@/lib/agent-catalog/agent-catalog'
import { cn } from '@/lib/class-names'
import type { GenerateFace } from './AvatarGenerateFace'

export function AgentMenu({
  face,
  disabled
}: {
  face: GenerateFace
  disabled: boolean
}): React.JSX.Element {
  const t = useTranslate()
  const { agent, agents } = face
  // One agent needs no choice; the progress line still names it.
  if (!agent || agents.length < 2) {
    return <span />
  }
  const label = getAgentLabel(agent)
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          disabled={disabled}
          aria-label={t('bots.avatar.generate.agent', 'Generate with {{agent}}', {
            agent: label
          })}
        >
          <AgentIcon agent={agent} size={14} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-36">
        {agents.map((entry) => (
          <DropdownMenuItem
            key={entry.agent}
            onSelect={() => {
              face.selectAgent(entry.agent)
              face.focusField(false)
            }}
          >
            <Check
              className={cn(
                'size-4 shrink-0 text-foreground',
                entry.agent === agent ? 'opacity-100' : 'opacity-0'
              )}
            />
            <AgentIconLabel
              icon={<AgentIcon agent={entry.agent} size={14} />}
              label={getAgentLabel(entry.agent)}
            />
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
