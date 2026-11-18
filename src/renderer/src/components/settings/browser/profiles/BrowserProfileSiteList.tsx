import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '../../../ui/button'
import { Textarea } from '../../../ui/textarea'
import { useTranslate } from '@/i18n/use-translate'
import {
  MAX_BROWSER_SITE_LIST_ENTRIES,
  parseBrowserSiteList
} from '../../../../../../shared/browser/profiles/browser-profile-site-list'

export function BrowserProfileSiteList({ profileId }: { profileId: string }): React.JSX.Element {
  const t = useTranslate()
  const [saved, setSaved] = useState<string[] | null>(null)
  const [text, setText] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let cancelled = false
    void Promise.resolve(window.api.browser.sessionGetAllowedHosts({ profileId })).then((hosts) => {
      if (!cancelled) {
        setSaved(hosts ?? [])
        setText((hosts ?? []).join('\n'))
      }
    })
    return () => {
      cancelled = true
    }
  }, [profileId])

  const parsed = parseBrowserSiteList(text)
  let error: string | null = null
  if (!parsed.ok) {
    const line = parsed.line ?? 0
    if (parsed.error === 'too-many') {
      error = t('browser.siteList.errorTooMany', 'At most {{max}} sites are allowed.', {
        max: MAX_BROWSER_SITE_LIST_ENTRIES
      })
    } else if (parsed.error === 'ip-address') {
      error = t('browser.siteList.errorIp', 'Line {{line}}: IP addresses are not supported.', {
        line
      })
    } else if (parsed.error === 'port-path-or-scheme') {
      error = t(
        'browser.siteList.errorForm',
        'Line {{line}}: enter only a host name, without a scheme, port or path.',
        { line }
      )
    } else {
      error = t('browser.siteList.errorInvalid', 'Line {{line}}: not a valid host name.', { line })
    }
  }
  const dirty = saved !== null && text !== saved.join('\n')

  const save = async (): Promise<void> => {
    if (!parsed.ok) {
      return
    }
    setSaving(true)
    try {
      const result = await window.api.browser.sessionSetAllowedHosts({
        profileId,
        hosts: parsed.entries
      })
      if (result?.ok) {
        setSaved(result.hosts)
        setText(result.hosts.join('\n'))
        toast.success(t('browser.siteList.saved', 'Site list saved.'))
      } else if (result?.reason !== 'cancelled') {
        toast.error(t('browser.siteList.saveFailed', 'Could not save the site list.'))
      }
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="mt-1.5 space-y-1.5 rounded-md border border-border/70 px-3 py-2.5">
      <p className="text-[11px] text-muted-foreground">
        {t(
          'browser.siteList.description',
          'Only these sites load in this profile. One host per line, such as example.com or *.example.com (subdomains only). Leave empty to allow every site.'
        )}
      </p>
      <Textarea
        variant="code"
        rows={4}
        value={text}
        disabled={saved === null || saving}
        spellCheck={false}
        aria-invalid={error !== null}
        aria-label={t('browser.siteList.label', 'Site list')}
        onChange={(e) => setText(e.target.value)}
      />
      {error ? <p className="text-[11px] text-destructive">{error}</p> : null}
      <Button size="xs" disabled={!dirty || error !== null || saving} onClick={() => void save()}>
        {t('browser.siteList.save', 'Save')}
      </Button>
    </div>
  )
}
