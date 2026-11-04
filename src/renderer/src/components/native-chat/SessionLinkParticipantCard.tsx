import { AI_VAULT_AGENT_LABELS } from '../../../../shared/ai-vault/contracts/ai-vault-types'
import type { SessionLinkParticipant } from '../../../../shared/session-link'
import { translate as t } from '@/i18n/i18n'

export function SessionLinkParticipantCard({
  participant,
  role
}: {
  participant: SessionLinkParticipant
  role: 'reviewer' | 'implementer'
}): React.JSX.Element {
  return (
    <div className="min-w-0 space-y-2 rounded-md border p-3">
      <p className="text-xs font-medium text-muted-foreground">
        {role === 'reviewer'
          ? t('components.sessionLink.reviewer', 'Leads and reviews')
          : t('components.sessionLink.implementer', 'Implements')}
      </p>
      <p className="break-words text-sm font-medium">{participant.name}</p>
      <p className="text-xs">{AI_VAULT_AGENT_LABELS[participant.agent]}</p>
      <p className="break-all font-mono text-xs text-muted-foreground">{participant.directory}</p>
      {participant.branch ? (
        <p className="break-all font-mono text-xs text-muted-foreground">
          {participant.branch.replace(/^refs\/heads\//, '')}
        </p>
      ) : null}
      {participant.task ? (
        <p className="whitespace-pre-wrap break-words text-xs">{participant.task}</p>
      ) : null}
    </div>
  )
}
