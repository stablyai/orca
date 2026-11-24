import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { useTranslate } from '@/i18n/use-translate'
import { installWindowVisibilityInterval } from '@/lib/window-activity/window-visibility-interval'
import type {
  CommanderAccount,
  CommanderMemoryApi
} from '../../../../shared/commander/memory-contract'

type Setting = Awaited<ReturnType<CommanderMemoryApi['recurringAnswers']>>

export function CommanderRecurringAnswersSwitch({
  account
}: {
  account: CommanderAccount
}): React.JSX.Element {
  const id = useId()
  const t = useTranslate()
  const [setting, setSetting] = useState<Setting | null>(null)
  const [readFailed, setReadFailed] = useState(false)
  const [writeFailed, setWriteFailed] = useState(false)
  const [saving, setSaving] = useState(false)
  const active = useRef(false)
  const writing = useRef(false)
  const needsRefresh = useRef(false)
  const sequence = useRef(0)
  const refresh = useCallback(async () => {
    const request = ++sequence.current
    try {
      const value = await window.api.commanderMemory.recurringAnswers(account)
      if (active.current && request === sequence.current) {
        setSetting(value)
        setReadFailed(false)
      }
    } catch {
      if (active.current && request === sequence.current) {
        setSetting(null)
        setReadFailed(true)
      }
    }
  }, [account])
  useEffect(() => {
    active.current = true
    setSetting(null)
    setReadFailed(false)
    const stop = installWindowVisibilityInterval({
      run: () => {
        if (writing.current) {
          needsRefresh.current = true
        } else {
          void refresh()
        }
      },
      intervalMs: 30_000,
      slowWhileUnfocused: true
    })
    return () => {
      active.current = false
      stop()
    }
  }, [refresh])

  async function change(enabled: boolean): Promise<void> {
    if (writing.current || !setting) {
      return
    }
    writing.current = true
    sequence.current++
    setSaving(true)
    setWriteFailed(false)
    try {
      const result = await window.api.commanderMemory.recurringAnswers(account, {
        enabled,
        expectedVersion: setting.version
      })
      setSetting(result)
    } catch {
      setWriteFailed(true)
      if (active.current) {
        await refresh()
      }
    }
    writing.current = false
    setSaving(false)
    if (active.current && needsRefresh.current) {
      needsRefresh.current = false
      void refresh()
    }
  }

  function description(): string {
    if (saving) {
      return t('commander.memory.saving', 'Saving…')
    }
    if (readFailed) {
      return t('commander.rules.settingUnavailable', 'Could not load the account setting.')
    }
    if (!setting) {
      return t('commander.rules.settingLoading', 'Checking the account setting…')
    }
    return setting.enabled
      ? t(
          'commander.rules.settingOn',
          'Across this account and organization, Commander can use each project’s saved answers for exact question matches.'
        )
      : t(
          'commander.rules.settingOff',
          'Automatic answers are paused across all projects in this account and organization. You can edit saved answers and view past decisions.'
        )
  }

  return (
    <div className="space-y-1 rounded-lg border border-border p-3">
      <div className="flex items-center gap-3">
        <div className="flex-1">
          <label className="block text-sm font-medium" htmlFor={id}>
            {t('commander.rules.settingLabel', 'Use recurring answers')}
          </label>
          <p id={`${id}-detail`} role="status" className="text-xs text-muted-foreground">
            {description()}
          </p>
        </div>
        <Switch
          id={id}
          aria-describedby={`${id}-detail`}
          disabled={!setting || saving}
          checked={setting?.enabled ?? false}
          onCheckedChange={(enabled) => void change(enabled)}
        />
      </div>
      {writeFailed && (
        <p role="alert" className="text-xs text-destructive">
          {t(
            'commander.rules.settingUnconfirmed',
            'Could not confirm your change. Review the account setting before trying again.'
          )}
        </p>
      )}
      {readFailed && (
        <Button
          size="xs"
          variant="ghost"
          onClick={() => {
            setReadFailed(false)
            void refresh()
          }}
        >
          {t('commander.memory.retry', 'Retry')}
        </Button>
      )}
    </div>
  )
}
