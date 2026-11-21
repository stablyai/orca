import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import type { BrowserSessionProfile } from '../../../../../../shared/browser/workspaces/browser-workspace-types'
import {
  MAX_BROWSER_SITE_LIST_ENTRIES,
  normalizeBrowserSiteListEntries
} from '../../../../../../shared/browser/profiles/browser-profile-site-list'
import type { BrowserSiteListSetResult } from '../../../../../../shared/browser/profiles/browser-profile-site-list'
import { Button } from '../../../ui/button'
import { Label } from '../../../ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../../ui/select'
import { Textarea } from '../../../ui/textarea'
import { useTranslate } from '@/i18n/use-translate'

// Null when the request itself failed. Kept outside the component: React Compiler cannot compile try/finally.
async function requestSiteListSave(
  profileId: string,
  hosts: string[],
  setSaving: (saving: boolean) => void
): Promise<BrowserSiteListSetResult | null> {
  setSaving(true)
  try {
    return await window.api.browser.sessionSetAllowedHosts({ profileId, hosts })
  } catch {
    return null
  } finally {
    setSaving(false)
  }
}

export function BrowserProfileSiteList({
  profiles
}: {
  profiles: Pick<BrowserSessionProfile, 'id' | 'label'>[]
}): React.JSX.Element {
  const t = useTranslate()
  const [pickedId, setPickedId] = useState(profiles[0]?.id ?? 'default')
  // A deleted pick falls back to a listed profile, so the editor never shows or saves a removed one.
  const profileId = profiles.some((profile) => profile.id === pickedId)
    ? pickedId
    : (profiles[0]?.id ?? 'default')
  const [saved, setSaved] = useState<string[] | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)
  const [text, setText] = useState('')
  const [saving, setSaving] = useState(false)

  // The profile on screen; a save that finishes after it changed must not fill in another profile.
  const shownProfileId = useRef(profileId)

  useEffect(() => {
    shownProfileId.current = profileId
    let cancelled = false
    setSaved(null)
    setLoadFailed(false)
    setText('')
    window.api.browser
      .sessionGetAllowedHosts({ profileId })
      .then((hosts) => {
        if (cancelled) {
          return
        }
        setSaved(hosts)
        setLoadFailed(hosts === null)
        setText(hosts?.join('\n') ?? '')
      })
      .catch(() => {
        if (!cancelled) {
          setLoadFailed(true)
        }
      })
    return () => {
      cancelled = true
    }
  }, [profileId])

  const parsed = normalizeBrowserSiteListEntries(text.split('\n').filter((line) => line.trim()))
  const error = parsed.ok
    ? null
    : parsed.invalid === undefined
      ? t('browser.siteList.errorTooMany', 'At most {{max}} sites are allowed.', {
          max: MAX_BROWSER_SITE_LIST_ENTRIES
        })
      : t(
          'browser.siteList.errorInvalid',
          '"{{entry}}" is not a host name such as example.com or *.example.com.',
          { entry: parsed.invalid }
        )

  const save = async (): Promise<void> => {
    if (!parsed.ok) {
      return
    }
    const savedFor = profileId
    const result = await requestSiteListSave(savedFor, parsed.entries, setSaving)
    if (shownProfileId.current !== savedFor) {
      return
    }
    if (result?.ok) {
      setSaved(result.hosts)
      setText(result.hosts.join('\n'))
      toast.success(t('browser.siteList.saved', 'Site list saved.'))
    } else if (result?.reason !== 'cancelled') {
      toast.error(t('browser.siteList.saveFailed', 'Could not save the site list.'))
    }
  }

  return (
    <div className="space-y-2 pt-3">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0 space-y-0.5">
          <Label>{t('browser.siteList.label', 'Site list')}</Label>
          <p className="text-xs text-muted-foreground">
            {t(
              'browser.siteList.description',
              'Only these sites load in the selected profile. One host per line, such as example.com or *.example.com (subdomains only; example.com itself needs its own line). IP addresses and single-word names other than localhost cannot be listed. Leave empty to allow every site.'
            )}
          </p>
        </div>
        <Select value={profileId} onValueChange={setPickedId} disabled={saving}>
          <SelectTrigger size="sm" className="max-w-48">
            <SelectValue />
          </SelectTrigger>
          <SelectContent align="end">
            {profiles.map((profile) => (
              <SelectItem key={profile.id} value={profile.id}>
                {profile.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
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
      {error || loadFailed ? (
        <p className="text-2xs text-destructive">
          {error ??
            t(
              'browser.siteList.loadFailed',
              "Couldn't read the saved site lists, so editing is disabled."
            )}
        </p>
      ) : null}
      <Button
        size="xs"
        disabled={saved === null || text === saved.join('\n') || error !== null || saving}
        onClick={() => void save()}
      >
        {t('browser.siteList.save', 'Save')}
      </Button>
    </div>
  )
}
