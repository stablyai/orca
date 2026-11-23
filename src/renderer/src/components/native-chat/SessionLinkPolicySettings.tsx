import { useState } from 'react'
import {
  SESSION_LINK_TURN_LIMIT,
  SessionLinkPolicy,
  type SessionLink
} from '../../../../shared/session-link'
import { useTranslate } from '@/i18n/use-translate'
import { Button } from '@/components/ui/button'
import { SessionLinkPolicyField } from './SessionLinkPolicyField'

export function SessionLinkPolicySettings({
  link,
  disabled,
  onSave
}: {
  link: SessionLink
  disabled: boolean
  onSave: (policy: SessionLinkPolicy, resume: boolean) => void
}): React.JSX.Element {
  const t = useTranslate()

  const [policy, setPolicy] = useState<SessionLinkPolicy>(
    link.policy ?? { turnLimit: SESSION_LINK_TURN_LIMIT }
  )
  const resume = link.state === 'paused' && ['turn-limit', 'message-limit'].includes(link.reason)
  return (
    <details open={resume} className="space-y-3 rounded-md border p-3">
      <summary className="cursor-pointer text-sm">
        {t('components.sessionLink.policySettings', 'Collaboration limits')}
      </summary>
      <SessionLinkPolicyField value={policy} onChange={setPolicy} disabled={disabled} />
      <Button
        variant={resume ? 'default' : 'outline'}
        autoFocus={resume}
        size="sm"
        disabled={disabled || !SessionLinkPolicy.safeParse(policy).success}
        onClick={() => onSave(policy, resume)}
      >
        {resume
          ? t('components.sessionLink.saveResume', 'Save and continue')
          : t('components.sessionLink.savePolicy', 'Save limits')}
      </Button>
    </details>
  )
}
