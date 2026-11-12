// @protected-copy
import { Check } from 'lucide-react'
import type { SessionLinkParticipant } from '../../../../shared/session-link'
import { tuiAgentDisplayName } from '../../../../shared/agent-launch/catalog/tui-agent-display-names'
import { useTranslate } from '@/i18n/use-translate'
import { Label } from '@/components/ui/label'
import {
  Command,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandItem
} from '@/components/ui/command'

export function SessionLinkParticipantPicker({
  candidates,
  selected,
  disabled,
  onSelect
}: {
  candidates: SessionLinkParticipant[]
  selected: string[]
  disabled: boolean
  onSelect: (sessionId: string) => void
}): React.JSX.Element {
  const t = useTranslate()

  return (
    <div className="space-y-1">
      <Label>{t('components.sessionLink.participants', 'Participants')}</Label>
      <Command>
        <CommandInput
          placeholder={t(
            'components.sessionLink.search',
            'Search agent, chat, workspace or branch…'
          )}
        />
        <CommandList className="max-h-48">
          <CommandEmpty>
            {t('components.sessionLink.availableEmpty', 'No available chats on this host.')}
          </CommandEmpty>
          {candidates.map((p) => (
            <CommandItem
              key={p.sessionId}
              disabled={disabled}
              value={`${p.sessionId} ${p.agent} ${p.name} ${p.directory} ${p.branch}`}
              onSelect={() => onSelect(p.sessionId)}
              data-current={selected.includes(p.sessionId) ? 'true' : undefined}
            >
              <Check
                className={`size-3 shrink-0 ${selected.includes(p.sessionId) ? 'opacity-100' : 'opacity-0'}`}
                aria-hidden
              />
              <div className="min-w-0 space-y-1">
                <div className="break-words text-sm">
                  {p.name}
                  <span className="ml-2 text-xs text-muted-foreground">
                    {tuiAgentDisplayName(p.agent) ?? p.agent}
                  </span>
                </div>
                <div className="break-all font-mono text-xs text-muted-foreground">
                  {p.directory}
                  {p.branch ? ` · ${p.branch}` : ''}
                </div>
              </div>
            </CommandItem>
          ))}
        </CommandList>
      </Command>
    </div>
  )
}
