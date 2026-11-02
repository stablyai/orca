import { Check } from 'lucide-react'
import { useState } from 'react'
import type { SessionLinkParticipant } from '../../../../shared/session-link'
import { translate as t } from '@/i18n/i18n'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import {
  Command,
  CommandInput,
  CommandItem,
  CommandList,
  CommandEmpty
} from '@/components/ui/command'

export function SessionLinkCreate({
  source,
  candidates,
  busy,
  onCreate
}: {
  source: SessionLinkParticipant
  candidates: SessionLinkParticipant[]
  busy: boolean
  onCreate: (partner: string, story: string, role: 'reviewer' | 'implementer') => void
}): React.JSX.Element {
  const [partner, setPartner] = useState('')
  const [story, setStory] = useState('')
  const [role, setRole] = useState<'reviewer' | 'implementer'>('implementer')
  const selected = candidates.find((p) => p.sessionId === partner)
  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <Label>{t('components.sessionLink.partner', 'Partner session')}</Label>
        <Command>
          <CommandInput
            placeholder={t(
              'components.sessionLink.search',
              'Search agent, chat, workspace or branch…'
            )}
          />
          <CommandList className="max-h-48">
            <CommandEmpty>
              {t('components.sessionLink.empty', 'No available local Claude or Codex chats.')}
            </CommandEmpty>
            {candidates.map((p) => (
              <CommandItem
                disabled={busy}
                key={p.sessionId}
                value={`${p.sessionId} ${p.agent} ${p.name} ${p.directory} ${p.branch}`}
                onSelect={() => setPartner(p.sessionId)}
                data-current={partner === p.sessionId ? 'true' : undefined}
              >
                <Check
                  className={`size-3 shrink-0 ${partner === p.sessionId ? 'opacity-100' : 'opacity-0'}`}
                  aria-hidden
                />
                <div className="min-w-0 space-y-1">
                  <div className="text-sm">
                    {p.agent} · {p.name}
                  </div>
                  <div className="break-all font-mono text-xs text-muted-foreground">
                    {p.directory} · {p.branch}
                  </div>
                </div>
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      </div>
      {selected ? (
        <div className="space-y-1 rounded-md border p-3">
          <p className="text-sm font-medium">
            {selected.agent} · {selected.name}
          </p>
          <p className="break-all font-mono text-xs text-muted-foreground">{selected.sessionId}</p>
          <p className="whitespace-pre-wrap text-sm">{selected.task}</p>
        </div>
      ) : null}
      <div className="space-y-2">
        <Label htmlFor="session-link-story">
          {t('components.sessionLink.story', 'Shared story')}
        </Label>
        <Textarea
          disabled={busy}
          id="session-link-story"
          value={story}
          onChange={(e) => setStory(e.target.value)}
          maxLength={2048}
          placeholder={t(
            'components.sessionLink.storyPlaceholder',
            'Goal, issue link or local plan path; existing spending and privacy boundaries…'
          )}
        />
        <p className="text-xs text-muted-foreground">
          {t(
            'components.sessionLink.noAutomaticRead',
            'Links and plan files are references. Their contents are not read or shared automatically.'
          )}
        </p>
      </div>
      <div className="space-y-2">
        <Label>{t('components.sessionLink.roles', 'Roles')}</Label>
        <p className="text-sm">
          {source.agent}:{' '}
          {role === 'implementer'
            ? t('components.sessionLink.implementer', 'Implements')
            : t('components.sessionLink.reviewer', 'Leads and reviews')}
        </p>
        <p className="text-sm">
          {selected?.agent ?? t('components.sessionLink.partner', 'Partner session')}:{' '}
          {role === 'implementer'
            ? t('components.sessionLink.reviewer', 'Leads and reviews')
            : t('components.sessionLink.implementer', 'Implements')}
        </p>
        <Button
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() => setRole(role === 'reviewer' ? 'implementer' : 'reviewer')}
        >
          {t('components.sessionLink.swap', 'Swap roles')}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        {t(
          'components.sessionLink.limits',
          'Up to 6 automatic turns, including introductions, or 12 agent messages before the owner continues. Agent messages do not grant permissions. Transport and journal stay on this host; model requests use each session’s provider and account.'
        )}
      </p>
      {selected?.workspaceId === source.workspaceId ? (
        <p className="text-xs text-chat-warning">
          {t(
            'components.sessionLink.sameWorkspace',
            'Both sessions use the same workspace. Coordinate file writes before editing.'
          )}
        </p>
      ) : null}
      <Button
        disabled={busy || !partner || !story.trim()}
        onClick={() => onCreate(partner, story, role)}
      >
        {busy
          ? t('components.sessionLink.creating', 'Creating link…')
          : t('components.sessionLink.create', 'Create link and introduce agents')}
      </Button>
    </div>
  )
}
