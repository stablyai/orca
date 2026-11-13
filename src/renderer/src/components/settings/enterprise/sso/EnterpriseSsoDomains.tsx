// The team's email domains for single sign-on. A domain counts only after the team publishes a DNS
// record we chose; until then it is listed as pending with the record to add.
import { useState } from 'react'
import { Check, Copy } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import type {
  OrcaOrgSsoDomain,
  OrcaOrgSsoDomainRefusal
} from '../../../../../../shared/orca-org-enterprise'

export type SsoDomainNotice = { domain: string | null; message: string }

export type EnterpriseSsoDomainsProps = {
  domains: OrcaOrgSsoDomain[]
  /** Owners of a team whose plan includes single sign-on. */
  canEdit: boolean
  /** The domain a request is in flight for, or `''` while adding. */
  busy: string | null
  notice: SsoDomainNotice | null
  onAdd: (domain: string) => void
  onVerify: (domain: string) => void
  onRemove: (domain: string) => void
  onCopy: (text: string) => void
}

export function ssoDomainRefusalCopy(reason: OrcaOrgSsoDomainRefusal, t: Translate): string {
  switch (reason) {
    case 'invalid-domain':
      return t('settings.enterprise.sso.domains.invalid', 'Enter a domain like example.com.')
    case 'public-domain':
      return t(
        'settings.enterprise.sso.domains.public',
        'That domain belongs to an email provider. Use a domain your company owns.'
      )
    case 'too-many-domains':
      return t('settings.enterprise.sso.domains.tooMany', 'A team can have up to 10 domains.')
    case 'domain-not-found':
      return t('settings.enterprise.sso.domains.notFound', 'That domain is no longer on the list.')
    case 'domain-taken':
      return t(
        'settings.enterprise.sso.domains.taken',
        'Another team has already verified that domain. Contact us if it should be yours.'
      )
    case 'record-not-found':
      return t(
        'settings.enterprise.sso.domains.recordNotFound',
        'We couldn’t find the record yet. DNS changes can take a few minutes; try again shortly.'
      )
    case 'dns-unavailable':
      return t(
        'settings.enterprise.sso.domains.dnsUnavailable',
        'We couldn’t look up the record. Try again in a moment.'
      )
  }
}

function CopyValue({
  label,
  value,
  onCopy
}: {
  label: string
  value: string
  onCopy: (text: string) => void
}): React.JSX.Element {
  const t = useTranslate()
  const [copied, setCopied] = useState(false)
  return (
    <div className="flex items-center gap-2">
      <span className="w-12 shrink-0 text-2xs text-muted-foreground">{label}</span>
      <code className="min-w-0 flex-1 truncate rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
        {value}
      </code>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label={t('settings.enterprise.sso.domains.copy', 'Copy {{label}}', { label })}
        onClick={() => {
          onCopy(value)
          setCopied(true)
          window.setTimeout(() => setCopied(false), 1500)
        }}
      >
        {copied ? <Check /> : <Copy />}
      </Button>
    </div>
  )
}

function DomainRow({
  entry,
  canEdit,
  busy,
  notice,
  onVerify,
  onRemove,
  onCopy
}: {
  entry: OrcaOrgSsoDomain
  canEdit: boolean
  busy: boolean
  notice: string | null
  onVerify: () => void
  onRemove: () => void
  onCopy: (text: string) => void
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <li className="space-y-2 py-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 truncate text-sm font-medium">{entry.domain}</span>
        {entry.status === 'verified' ? (
          <Badge variant="statusSuccess">
            {t('settings.enterprise.sso.domains.verified', 'Verified')}
          </Badge>
        ) : entry.status === 'pending' ? (
          <Badge variant="tag">
            {t('settings.enterprise.sso.domains.pending', 'Not verified')}
          </Badge>
        ) : (
          <Badge variant="tag">
            {t('settings.enterprise.sso.domains.recordMissing', 'Record missing')}
          </Badge>
        )}
        {canEdit ? (
          <div className="ml-auto flex items-center gap-1">
            {entry.status !== 'verified' ? (
              <Button type="button" variant="outline" size="xs" disabled={busy} onClick={onVerify}>
                {t('settings.enterprise.sso.domains.check', 'Check record')}
              </Button>
            ) : null}
            <Button type="button" variant="ghost" size="xs" disabled={busy} onClick={onRemove}>
              {t('settings.enterprise.sso.domains.remove', 'Remove')}
            </Button>
          </div>
        ) : null}
      </div>
      {entry.status !== 'verified' ? (
        <div className="space-y-1.5">
          <p className="text-xs text-muted-foreground text-pretty">
            {entry.status === 'pending'
              ? t(
                  'settings.enterprise.sso.domains.pendingBody',
                  'Add this TXT record at your DNS provider to show the domain is yours.'
                )
              : t(
                  'settings.enterprise.sso.domains.recordMissingBody',
                  'The TXT record is gone. Sign-in still works; add the record back to keep the domain verified.'
                )}
          </p>
          <CopyValue
            label={t('settings.enterprise.sso.domains.recordName', 'Name')}
            value={entry.record.name}
            onCopy={onCopy}
          />
          <CopyValue
            label={t('settings.enterprise.sso.domains.recordValue', 'Value')}
            value={entry.record.value}
            onCopy={onCopy}
          />
        </div>
      ) : null}
      {notice ? (
        <p role="status" className="text-xs text-muted-foreground text-pretty">
          {notice}
        </p>
      ) : null}
    </li>
  )
}

export function EnterpriseSsoDomains({
  domains,
  canEdit,
  busy,
  notice,
  onAdd,
  onVerify,
  onRemove,
  onCopy
}: EnterpriseSsoDomainsProps): React.JSX.Element {
  const t = useTranslate()
  const [draft, setDraft] = useState('')
  const adding = busy === ''
  const submit = (): void => {
    const domain = draft.trim()
    if (domain && !adding) {
      onAdd(domain)
      setDraft('')
    }
  }
  return (
    <div data-settings-row="" className="space-y-2 py-4">
      <div className="space-y-0.5">
        <p className="text-sm font-medium">
          {t('settings.enterprise.sso.domains.title', 'Email domains')}
        </p>
        <p className="text-xs text-muted-foreground text-pretty">
          {t(
            'settings.enterprise.sso.domains.body',
            'People who sign in with SSO using an email at one of these domains are sent to your identity provider.'
          )}
        </p>
      </div>
      {domains.length > 0 ? (
        <ul
          aria-label={t('settings.enterprise.sso.domains.title', 'Email domains')}
          className="divide-y divide-border"
        >
          {domains.map((entry) => (
            <DomainRow
              key={entry.domain}
              entry={entry}
              canEdit={canEdit}
              busy={busy === entry.domain}
              notice={notice?.domain === entry.domain ? notice.message : null}
              onVerify={() => onVerify(entry.domain)}
              onRemove={() => onRemove(entry.domain)}
              onCopy={onCopy}
            />
          ))}
        </ul>
      ) : (
        <p className="text-xs text-muted-foreground">
          {t('settings.enterprise.sso.domains.none', 'No domains yet.')}
        </p>
      )}
      {canEdit ? (
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            submit()
          }}
        >
          <Input
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder={t('settings.enterprise.sso.domains.placeholder', 'example.com')}
            aria-label={t('settings.enterprise.sso.domains.inputLabel', 'Domain to add')}
            className="h-8 w-56"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
          />
          <Button type="submit" variant="outline" size="sm" disabled={adding || !draft.trim()}>
            {t('settings.enterprise.sso.domains.add', 'Add domain')}
          </Button>
        </form>
      ) : null}
      {notice && notice.domain === null ? (
        <p role="status" className="text-xs text-muted-foreground text-pretty">
          {notice.message}
        </p>
      ) : null}
    </div>
  )
}
