import { useId, useState } from 'react'
import { FolderOpen, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useTranslate } from '@/i18n/use-translate'
import { isWindowsAbsolutePathLike } from '../../../../../../shared/file-access/cross-platform-path'
import type { CodexAccountActionRunner } from '../accounts-pane-types'
import type { LocalAccountRuntime } from '@/lib/provider-accounts/account-runtime-label'

type ImportProps = {
  runtime: LocalAccountRuntime
  disabled: boolean
  runAction: CodexAccountActionRunner
}

export function CodexHomeImportForm({
  runtime,
  disabled,
  runAction,
  onImported
}: ImportProps & {
  onImported: () => void
}) {
  const t = useTranslate()
  const inputId = useId()
  const [sourceHome, setSourceHome] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const unavailable = disabled || busy

  const browse = async () => {
    setBusy(true)
    setError(null)
    try {
      const path = await window.api.shell.pickDirectory({
        defaultPath: sourceHome.trim() || undefined
      })
      if (path) {
        setSourceHome(path)
      }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    }
    setBusy(false)
  }

  const importHome = async () => {
    if (unavailable) {
      return
    }
    const path = sourceHome.trim().replace(/^"(.*)"$/, '$1')
    if (!isWindowsAbsolutePathLike(path) && !path.startsWith('/')) {
      setError(t('accounts.codex.import.absolutePath', 'Enter a full directory path.'))
      return
    }
    setBusy(true)
    setError(null)
    let imported = false
    try {
      await runAction('importing', async () => {
        try {
          const next = await window.api.codexAccounts.importHome({
            sourceHome: path,
            runtime: runtime.runtime,
            wslDistro: runtime.wslDistro
          })
          imported = true
          return next
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
          throw failure
        }
      })
      if (imported) {
        onImported()
      }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    }
    setBusy(false)
  }

  return (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault()
        void importHome()
      }}
    >
      <div className="space-y-1">
        <h3 className="text-sm font-medium">
          {t('accounts.codex.import.title', 'Import Codex account')}
        </h3>
        <p className="text-xs text-muted-foreground">
          {t(
            'accounts.codex.import.description',
            'Copy auth.json into a new Orca account home and activate it for {{host}}. The source folder stays unchanged.',
            { host: runtime.label }
          )}
        </p>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={inputId}>{t('accounts.codex.import.home', 'Codex home directory')}</Label>
        <div className="flex gap-2">
          <Input
            id={inputId}
            value={sourceHome}
            onChange={(event) => {
              setSourceHome(event.target.value)
              setError(null)
            }}
            disabled={unavailable}
            aria-invalid={Boolean(error)}
            aria-describedby={error ? `${inputId}-error` : `${inputId}-hint`}
            autoComplete="off"
            spellCheck={false}
            variant="code"
            className="min-w-0"
          />
          <Button
            type="button"
            variant="outline"
            onClick={() => void browse()}
            disabled={unavailable}
          >
            {t('accounts.codex.import.browse', 'Browse…')}
          </Button>
        </div>
        <p id={`${inputId}-hint`} className="text-xs text-muted-foreground">
          {t(
            'accounts.codex.import.hint',
            'Choose the folder containing auth.json, not the file itself.'
          )}
        </p>
        {runtime.runtime === 'wsl' && (
          <p className="text-xs text-muted-foreground">
            {t(
              'accounts.codex.import.wslHint',
              'For WSL, choose its home folder through the Windows file picker.'
            )}
          </p>
        )}
        {error && (
          <p id={`${inputId}-error`} role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}
      </div>
      <Button type="submit" disabled={unavailable || !sourceHome.trim()} className="w-full">
        {busy && <Loader2 className="size-4 animate-spin" />}
        {t('accounts.codex.import.submit', 'Import account')}
      </Button>
    </form>
  )
}

export function CodexHomeImport(props: ImportProps) {
  const t = useTranslate()
  const [open, setOpen] = useState(false)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="xs" disabled={props.disabled}>
          <FolderOpen className="size-3" />
          {t('accounts.codex.import.trigger', 'Import from home…')}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 max-w-[calc(100vw-2rem)]">
        <div className="p-4">
          <CodexHomeImportForm {...props} onImported={() => setOpen(false)} />
        </div>
      </PopoverContent>
    </Popover>
  )
}
