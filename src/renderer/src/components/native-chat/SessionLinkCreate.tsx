import { useState } from 'react'
import {
  SESSION_LINK_DEFAULT_TURN_LIMIT,
  SessionLinkPolicy,
  type SessionLinkParticipant
} from '../../../../shared/session-link'
import { useTranslate } from '@/i18n/use-translate'
import { SessionLinkPolicyField } from './SessionLinkPolicyField'
import { SessionLinkParticipantCard } from './SessionLinkParticipantCard'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { SessionLinkParticipantPicker } from './SessionLinkParticipantPicker'

export function SessionLinkCreate({
  source,
  candidates,
  initialPartnerSessionId,
  busy,
  policySupported = false,
  groupSupported = false,
  onCreate
}: {
  source: SessionLinkParticipant
  candidates: SessionLinkParticipant[]
  initialPartnerSessionId?: string
  busy: boolean
  policySupported?: boolean
  groupSupported?: boolean
  onCreate: (
    partners: string[],
    story: string,
    role: 'reviewer' | 'implementer',
    policy?: SessionLinkPolicy
  ) => void
}): React.JSX.Element {
  const t = useTranslate()

  const [partners, setPartners] = useState<string[]>(
    initialPartnerSessionId ? [initialPartnerSessionId] : []
  )
  const [choosingPartner, setChoosingPartner] = useState(!initialPartnerSessionId)
  const [story, setStory] = useState('')
  const [policy, setPolicy] = useState<SessionLinkPolicy>({
    turnLimit: SESSION_LINK_DEFAULT_TURN_LIMIT
  })
  const [role, setRole] = useState<'reviewer' | 'implementer'>(
    source.agent === 'claude' ? 'reviewer' : 'implementer'
  )
  const selected = candidates.filter((p) => partners.includes(p.sessionId))
  const unavailable = partners.some((id) => !candidates.some((p) => p.sessionId === id))
  return (
    <div className="space-y-4">
      {choosingPartner ? (
        <SessionLinkParticipantPicker
          candidates={candidates}
          selected={partners}
          disabled={busy}
          onSelect={(id) => {
            setPartners((ids) =>
              groupSupported
                ? ids.includes(id)
                  ? ids.filter((i) => i !== id)
                  : [...ids, id]
                : [id]
            )
            if (!groupSupported) {
              setChoosingPartner(false)
            }
          }}
        />
      ) : null}
      <div className="grid gap-3 sm:grid-cols-2">
        <SessionLinkParticipantCard participant={source} role={role} />
        {selected.map((participant) => (
          <SessionLinkParticipantCard
            key={participant.sessionId}
            participant={participant}
            role={role === 'implementer' ? 'reviewer' : 'implementer'}
          />
        ))}
        {unavailable || !selected.length ? (
          <p
            role={unavailable ? 'alert' : undefined}
            className="rounded-md border p-3 text-sm text-muted-foreground"
          >
            {unavailable
              ? t(
                  'components.sessionLink.partnerUnavailable',
                  'The selected chat is no longer available. Choose another partner.'
                )
              : t('components.sessionLink.chooseParticipants', 'Choose chats to connect.')}
          </p>
        ) : null}
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={busy || !selected.length}
          onClick={() => setRole(role === 'reviewer' ? 'implementer' : 'reviewer')}
        >
          {t('components.sessionLink.swap', 'Swap roles')}
        </Button>
        {!choosingPartner ? (
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => setChoosingPartner(true)}
          >
            {groupSupported
              ? t('components.sessionLink.chooseAgents', 'Choose agents')
              : t('components.sessionLink.changePartner', 'Change partner')}
          </Button>
        ) : null}
      </div>
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
      {policySupported ? (
        <SessionLinkPolicyField value={policy} onChange={setPolicy} disabled={busy} />
      ) : null}
      <p className="text-xs text-muted-foreground">
        {policySupported
          ? t(
              'components.sessionLink.localTransport',
              'Agent messages do not grant permissions. Transport and journal stay on this host; model requests use each session’s provider and account.'
            )
          : t(
              'components.sessionLink.limits',
              'Up to 6 automatic turns, including introductions, or 12 agent messages before the owner continues. Agent messages do not grant permissions. Transport and journal stay on this host; model requests use each session’s provider and account.'
            )}
      </p>
      {selected.some((p) => p.workspaceId === source.workspaceId) ? (
        <p className="text-xs text-chat-warning">
          {t(
            'components.sessionLink.groupSameWorkspace',
            'Some participants use the same workspace. Coordinate file writes before editing.'
          )}
        </p>
      ) : null}
      <Button
        disabled={
          busy ||
          !selected.length ||
          unavailable ||
          !story.trim() ||
          (policySupported && !SessionLinkPolicy.safeParse(policy).success)
        }
        onClick={() =>
          policySupported
            ? onCreate(partners, story, role, policy)
            : onCreate(partners, story, role)
        }
      >
        {busy
          ? t('components.sessionLink.creating', 'Creating link…')
          : t('components.sessionLink.create', 'Create link and introduce agents')}
      </Button>
    </div>
  )
}
