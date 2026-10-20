import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { REPOSITORY_ADD_SCRIPT_MAX_LENGTH } from '../../../../shared/repository-add-script-settings'
import { isWebClientLocation } from '@/lib/web-client-location'
import { translate } from '@/i18n/i18n'
import { runtimeTargetEnvironmentId } from '@/runtime/runtime-client-target'
import { useAppStore } from '@/store'
import { Button } from '../ui/button'
import { Label } from '../ui/label'
import { Textarea } from '../ui/textarea'
import { SettingsHostScopeUnavailableNotice } from './SettingsHostScopePicker'
import type { SettingsHostScope } from './settings-host-scope'
import {
  readHostRepositoryAddScript,
  writeHostRepositoryAddScript
} from './repository-add-script-setting-transport'

/** Fixed height keeps the row from jumping as the script grows. */
const REPOSITORY_ADD_SCRIPT_TEXTAREA_ROWS = 6

type RepositoryAddScriptSettingProps = {
  settings: GlobalSettings
  updateSettingsOrThrow: (updates: Partial<GlobalSettings>) => void | Promise<void>
  hostScope: SettingsHostScope
}

export function RepositoryAddScriptSetting({
  settings,
  updateSettingsOrThrow,
  hostScope
}: RepositoryAddScriptSettingProps): React.JSX.Element {
  const environmentId = runtimeTargetEnvironmentId(hostScope.target)
  const environment = useAppStore((state) =>
    environmentId ? state.runtimeEnvironments.find((entry) => entry.id === environmentId) : null
  )
  if (!environmentId) {
    // Why: the web client's settings API deliberately drops this host-owned value.
    return isWebClientLocation() ? (
      <p className="text-sm text-muted-foreground">
        {translate(
          'settings.repositoryAddScript.webUnavailable',
          'The repository add script can’t be edited from the web client. Open this host’s Settings in the desktop app.'
        )}
      </p>
    ) : (
      <LocalRepositoryAddScriptSetting
        settings={settings}
        updateSettingsOrThrow={updateSettingsOrThrow}
      />
    )
  }
  if (!environment) {
    return hostScope.available ? (
      <p className="text-sm text-muted-foreground">
        {translate('settings.repositoryAddScript.loadingHost', 'Loading repository add script…')}
      </p>
    ) : (
      <SettingsHostScopeUnavailableNotice />
    )
  }
  return (
    <HostRepositoryAddScriptSetting
      key={`${environmentId}:${environment.pairingRevision ?? environment.createdAt}`}
      environmentId={environmentId}
      pairingRevision={environment.pairingRevision ?? environment.createdAt}
      hostName={environment.name}
    />
  )
}

function LocalRepositoryAddScriptSetting({
  settings,
  updateSettingsOrThrow
}: {
  settings: GlobalSettings
  updateSettingsOrThrow: (updates: Partial<GlobalSettings>) => void | Promise<void>
}): React.JSX.Element {
  const initialScript = settings.repositoryAddScript ?? ''
  const [draft, setDraft] = useState(initialScript)
  const draftRef = useRef(initialScript)
  const baselineRef = useRef(initialScript)
  const [saving, setSaving] = useState(false)
  const [saveFailed, setSaveFailed] = useState(false)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    const next = settings.repositoryAddScript ?? ''
    if (next === baselineRef.current) {
      return
    }
    const previous = baselineRef.current
    baselineRef.current = next
    // Why: an external change must not discard text the user is still editing.
    if (draftRef.current !== previous) {
      return
    }
    draftRef.current = next
    setDraft(next)
    // oxlint-disable-next-line react-doctor/no-adjust-state-on-prop-change -- Why: adoption is limited to a clean draft; clearing feedback cannot be derived without a stray render.
    setSaved(false)
    // oxlint-disable-next-line react-doctor/no-adjust-state-on-prop-change -- Why: the adopted value replaces the one the earlier failure described.
    setSaveFailed(false)
  }, [settings.repositoryAddScript])

  const save = async (script: string): Promise<void> => {
    const draftAtStart = draftRef.current
    setSaving(true)
    setSaveFailed(false)
    setSaved(false)
    try {
      await updateSettingsOrThrow({ repositoryAddScript: script })
      // Why: the action writes the host's normalized settings into the store; the stale render prop is not authoritative.
      const echoed = useAppStore.getState().settings?.repositoryAddScript ?? ''
      baselineRef.current = echoed
      // Why: text typed while the save was in flight is not covered by that save.
      if (draftRef.current !== draftAtStart) {
        return
      }
      draftRef.current = echoed
      setDraft(echoed)
      setSaved(true)
    } catch {
      setSaveFailed(true)
    } finally {
      setSaving(false)
    }
  }

  return (
    <RepositoryAddScriptField
      value={draft}
      description={translate(
        'settings.repositoryAddScript.localDescription',
        'A script Orca offers to run on this computer when a Git repository is first added. It runs from the repository root, and you can run or skip it each time.'
      )}
      saving={saving}
      saveFailed={saveFailed}
      saved={saved}
      onChange={(value) => {
        draftRef.current = value
        setDraft(value)
        setSaved(false)
      }}
      onSave={() => void save(draftRef.current)}
      onClear={() => void save('')}
    />
  )
}

type HostReadState = { kind: 'loading' | 'unsupported' | 'failed' } | { kind: 'ready' }

function HostRepositoryAddScriptSetting({
  environmentId,
  pairingRevision,
  hostName
}: {
  environmentId: string
  pairingRevision: number
  hostName: string
}): React.JSX.Element {
  const owner = useMemo(
    () => ({ environmentId, pairingRevision }),
    [environmentId, pairingRevision]
  )
  const abortRef = useRef<AbortController | null>(null)
  const mutationTail = useRef<Promise<void> | null>(null)
  const [read, setRead] = useState<HostReadState>({ kind: 'loading' })
  const [draft, setDraft] = useState('')
  const draftRef = useRef('')
  const baselineRef = useRef('')
  const [saving, setSaving] = useState(false)
  const [saveFailed, setSaveFailed] = useState(false)
  const [saved, setSaved] = useState(false)

  const refresh = useCallback(async (): Promise<void> => {
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    setRead({ kind: 'loading' })
    setSaving(false)
    setSaveFailed(false)
    setSaved(false)
    try {
      const script = await readHostRepositoryAddScript(owner, controller.signal)
      if (controller.signal.aborted) {
        return
      }
      if (script === null) {
        setRead({ kind: 'unsupported' })
        return
      }
      draftRef.current = script
      baselineRef.current = script
      setDraft(script)
      setRead({ kind: 'ready' })
    } catch {
      if (!controller.signal.aborted) {
        setRead({ kind: 'failed' })
      }
    }
  }, [owner])

  useEffect(() => {
    void refresh()
    return () => abortRef.current?.abort()
  }, [refresh])

  const save = (script: string): void => {
    const draftAtStart = draftRef.current
    const controller = abortRef.current
    if (!controller || controller.signal.aborted || read.kind !== 'ready') {
      return
    }
    // Why: one connection can carry several edits; run them in order without dropping a click.
    const write = (mutationTail.current ?? Promise.resolve())
      .catch(() => undefined)
      .then(async () => {
        if (controller.signal.aborted) {
          return
        }
        setSaving(true)
        setSaveFailed(false)
        setSaved(false)
        try {
          const next = await writeHostRepositoryAddScript(owner, script, controller.signal)
          if (controller.signal.aborted) {
            return
          }
          if (next === null) {
            setSaveFailed(true)
            return
          }
          baselineRef.current = next
          // Why: text typed while the write was in flight is not covered by that write.
          if (draftRef.current !== draftAtStart) {
            return
          }
          draftRef.current = next
          setDraft(next)
          setSaved(true)
        } catch {
          if (!controller.signal.aborted) {
            setSaveFailed(true)
          }
        } finally {
          if (!controller.signal.aborted) {
            setSaving(false)
          }
        }
      })
    mutationTail.current = write
  }

  if (read.kind !== 'ready') {
    return (
      <div className="space-y-2 text-sm text-muted-foreground">
        <p>
          {read.kind === 'loading'
            ? translate(
                'settings.repositoryAddScript.loadingHost',
                'Loading repository add script…'
              )
            : read.kind === 'unsupported'
              ? translate(
                  'settings.repositoryAddScript.unsupportedHost',
                  'Update this server to edit its repository add script.'
                )
              : translate(
                  'settings.repositoryAddScript.readFailedHost',
                  'Couldn’t read the repository add script. Check the host connection and try again.'
                )}
        </p>
        {read.kind === 'failed' ? (
          <Button type="button" variant="ghost" size="xs" onClick={() => void refresh()}>
            {translate('settings.repositoryAddScript.retry', 'Retry')}
          </Button>
        ) : null}
      </div>
    )
  }

  return (
    <RepositoryAddScriptField
      value={draft}
      description={translate(
        'settings.repositoryAddScript.hostDescription',
        'A script Orca offers to run on {{host}} when a Git repository is first added. It runs from the repository root, and you can run or skip it each time.',
        { host: hostName }
      )}
      saving={saving}
      saveFailed={saveFailed}
      saved={saved}
      onChange={(value) => {
        draftRef.current = value
        setDraft(value)
        setSaved(false)
      }}
      onSave={() => save(draftRef.current)}
      onClear={() => save('')}
    />
  )
}

function RepositoryAddScriptField({
  value,
  description,
  saving,
  saveFailed,
  saved,
  onChange,
  onSave,
  onClear
}: {
  value: string
  description: string
  saving: boolean
  saveFailed: boolean
  saved: boolean
  onChange: (value: string) => void
  onSave: () => void
  onClear: () => void
}): React.JSX.Element {
  const fieldId = useId()
  const descriptionId = `${fieldId}-description`
  const tooLong = value.length > REPOSITORY_ADD_SCRIPT_MAX_LENGTH
  const saveDisabled = saving || tooLong
  return (
    <div className="space-y-2">
      <div className="space-y-1">
        <Label htmlFor={fieldId}>
          {translate('settings.repositoryAddScript.title', 'Repository add script')}
        </Label>
        <p id={descriptionId} className="text-xs text-muted-foreground">
          {description}
        </p>
      </div>
      <Textarea
        id={fieldId}
        value={value}
        rows={REPOSITORY_ADD_SCRIPT_TEXTAREA_ROWS}
        maxLength={REPOSITORY_ADD_SCRIPT_MAX_LENGTH}
        spellCheck={false}
        aria-describedby={descriptionId}
        aria-invalid={tooLong ? true : undefined}
        variant="code"
        onChange={(event) => onChange(event.target.value)}
      />
      {tooLong ? (
        <p role="alert" className="text-xs text-destructive">
          {translate(
            'settings.repositoryAddScript.tooLong',
            'The script is longer than {{max}} characters. Shorten it before saving.',
            { max: String(REPOSITORY_ADD_SCRIPT_MAX_LENGTH) }
          )}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" onClick={onSave} disabled={saveDisabled}>
          {translate('settings.repositoryAddScript.save', 'Save')}
        </Button>
        <Button type="button" variant="secondary" onClick={onClear} disabled={saving}>
          {translate('settings.repositoryAddScript.clear', 'Clear')}
        </Button>
      </div>
      {saveFailed ? (
        <p role="alert" className="text-xs text-destructive">
          {translate(
            'settings.repositoryAddScript.saveFailed',
            'Couldn’t save the script. Check the host connection and try again.'
          )}
        </p>
      ) : null}
      {saved ? (
        <p role="status" className="text-xs text-muted-foreground">
          {translate('settings.repositoryAddScript.saved', 'Saved')}
        </p>
      ) : null}
    </div>
  )
}
