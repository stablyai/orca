import { useState } from 'react'
import { SessionLinkPolicy, type SessionLink } from '../../../../shared/session-link'
import { translate as t } from '@/i18n/i18n'
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
  const [policy, setPolicy] = useState<SessionLinkPolicy>(link.policy ?? { turnLimit: 6 })
  const resume = link.state === 'paused' && ['turn-limit', 'message-limit'].includes(link.reason)
  return (
    <details className="space-y-3 rounded-md border p-3">
      <summary className="cursor-pointer text-sm">
        {t('components.sessionLink.policySettings', 'Collaboration limits')}
      </summary>
      <SessionLinkPolicyField value={policy} onChange={setPolicy} disabled={disabled} />
      <Button
        variant="outline"
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
