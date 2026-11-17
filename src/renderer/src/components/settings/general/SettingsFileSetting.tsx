import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import type { SettingsFileStatus } from '../../../../../shared/settings/settings-file/settings-file-status-types'
import { isWebClientLocation } from '@/app-shell/platform/web-client-location'
import { useMountedRef } from '@/hooks/useMountedRef'
import { useTranslate } from '@/i18n/use-translate'
import { Button } from '../../ui/button'
import { Label } from '../../ui/label'
import { getGeneralSettingsFileSearchEntry } from './general-search'
import { GENERAL_SETTING_ANCHORS } from './general-setting-anchors'
import { SearchableSetting } from '../section-layout/SearchableSetting'

const MAX_LISTED_IGNORED_KEYS = 5

type SettingsFileSettingViewProps = {
  status: SettingsFileStatus
  pending: boolean
  onCreate: () => void
  onOpen: () => void
}

export function SettingsFileSettingView({
  status,
  pending,
  onCreate,
  onOpen
}: SettingsFileSettingViewProps): React.JSX.Element {
  const t = useTranslate()
  const entry = getGeneralSettingsFileSearchEntry()
  const listedKeys = status.ignored.slice(0, MAX_LISTED_IGNORED_KEYS)
  const hiddenKeyCount = status.ignored.length - listedKeys.length

  return (
    <SearchableSetting
      id={GENERAL_SETTING_ANCHORS.settingsFile}
      title={entry.title}
      description={entry.description}
      keywords={entry.keywords}
    >
      <div className="space-y-2 py-3">
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0 flex-1 space-y-1">
            <Label className="select-text">{entry.title}</Label>
            <p className="select-text text-xs text-muted-foreground">{entry.description}</p>
          </div>
          <div className="shrink-0">
            {status.state === 'absent' ? (
              <Button variant="outline" size="sm" disabled={pending} onClick={onCreate}>
                {t(
                  'auto.components.settings.SettingsFileSetting.ff84319f89',
                  'Create settings file'
                )}
              </Button>
            ) : (
              <Button variant="outline" size="sm" onClick={onOpen}>
                {t('auto.components.settings.SettingsFileSetting.fd6ead6c3a', 'Open file')}
              </Button>
            )}
          </div>
        </div>
        <code className="block select-text break-all font-mono text-xs text-muted-foreground">
          {status.path}
        </code>
        {status.state === 'active' ? (
          <p className="text-xs text-muted-foreground">
            {t(
              'auto.components.settings.SettingsFileSetting.26ce59dab3',
              'Using this file · {{count}} settings',
              {
                count: status.appliedKeyCount,
                defaultValue_one: 'Using this file · {{count}} setting'
              }
            )}
          </p>
        ) : null}
        {status.state === 'invalid' ? (
          <p role="alert" className="text-xs text-destructive">
            {status.message
              ? t(
                  'auto.components.settings.SettingsFileSetting.e19be5ebf6',
                  'The file could not be read: {{message}}. Fix it to resume syncing.',
                  { message: status.message }
                )
              : t(
                  'auto.components.settings.SettingsFileSetting.0301bcadce',
                  'The file could not be read. Fix it to resume syncing.'
                )}
          </p>
        ) : null}
        {status.state === 'read-only' ? (
          <p className="text-xs text-status-warning-text">
            {t(
              'auto.components.settings.SettingsFileSetting.1d03236030',
              'The file is read-only. Changes made here stay on this device until the file changes or Orca restarts.'
            )}
          </p>
        ) : null}
        {status.ignored.length > 0 ? (
          <div className="space-y-1 text-xs text-muted-foreground">
            <p>
              {t(
                'auto.components.settings.SettingsFileSetting.c0ce8dadaf',
                '{{count}} entries were ignored',
                {
                  count: status.ignored.length,
                  defaultValue_one: '{{count}} entry was ignored'
                }
              )}
            </p>
            <ul className="select-text font-mono">
              {listedKeys.map(({ key }) => (
                <li key={key}>{key}</li>
              ))}
            </ul>
            {hiddenKeyCount > 0 ? (
              <p>
                {t(
                  'auto.components.settings.SettingsFileSetting.d57ac76822',
                  'and {{moreCount}} more',
                  { moreCount: hiddenKeyCount }
                )}
              </p>
            ) : null}
          </div>
        ) : null}
      </div>
    </SearchableSetting>
  )
}

export function SettingsFileSetting(): React.JSX.Element | null {
  const t = useTranslate()
  const mountedRef = useMountedRef()
  const isWebClient = isWebClientLocation()
  const [status, setStatus] = useState<SettingsFileStatus | null>(null)
  const [pending, setPending] = useState(false)

  useEffect(() => {
    if (isWebClient) {
      return
    }
    let cancelled = false
    void window.api.settingsFile.getStatus().then((next) => {
      if (!cancelled) {
        setStatus(next)
      }
    })
    const unsubscribe = window.api.settingsFile.onStatusChanged(setStatus)
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [isWebClient])

  const create = useCallback(async (): Promise<void> => {
    setPending(true)
    try {
      setStatus(await window.api.settingsFile.create())
    } catch {
      toast.error(
        t(
          'auto.components.settings.SettingsFileSetting.a0928296e1',
          'Could not create the settings file.'
        )
      )
    }
    if (mountedRef.current) {
      setPending(false)
    }
  }, [mountedRef, t])

  const open = useCallback(async (): Promise<void> => {
    const error = await window.api.settingsFile.open()
    if (error) {
      toast.error(error)
    }
  }, [])

  if (isWebClient || !status) {
    return null
  }
  return (
    <SettingsFileSettingView
      status={status}
      pending={pending}
      onCreate={() => void create()}
      onOpen={() => void open()}
    />
  )
}
