import { useId, useState } from 'react'
import { FolderOpen, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useTranslate } from '@/i18n/use-translate'
import { isWindowsAbsolutePathLike } from '../../../../../shared/file-access/cross-platform-path'
import type { LocalAccountRuntime } from '@/lib/provider-accounts/account-runtime-label'

type ImportProps<T> = {
  provider: 'Codex'
  importAccount: (path: string) => Promise<T>
  runtime: LocalAccountRuntime
  disabled: boolean
  runAction: (action: 'importing', operation: () => Promise<T>) => Promise<void>
}

export function AccountHomeImportForm<T>({
  provider,
  importAccount,
  runtime,
  disabled,
  runAction,
  onImported
}: ImportProps<T> & {
  onImported: () => void
}) {
  const t = useTranslate()
  const inputId = useId()
  const [sourceHome, setSourceHome] = useState('')
  const [pickedPath, setPickedPath] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const unavailable = disabled || busy

  const browse = async () => {
    setBusy(true)
    setError(null)
    try {
      const path = await window.api.shell.pickDirectory({
        defaultPath: sourceHome.trim() ? sourceHome : undefined
      })
      if (path) {
        setSourceHome(path)
        setPickedPath(true)
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
    const path = pickedPath ? sourceHome : sourceHome.replace(/^"(.*)"$/, '$1')
    if (!isWindowsAbsolutePathLike(path) && !path.startsWith('/')) {
      setError(t('accounts.homeImport.absolutePath', 'Enter a full directory path.'))
      return
    }
    setBusy(true)
    setError(null)
    let imported = false
    try {
      await runAction('importing', async () => {
        try {
          const next = await importAccount(path)
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
          {t('accounts.homeImport.title', 'Import {{provider}} account', { provider })}
        </h3>
        <p className="text-xs text-muted-foreground">
          {t(
            'accounts.homeImport.description',
            'Copy a login into a new Orca account home and activate it for {{host}}. The source sign-in is preserved.',
            { host: runtime.label }
          )}
        </p>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={inputId}>
          {t('accounts.homeImport.home', '{{provider}} home directory', { provider })}
        </Label>
        <div className="flex gap-2">
          <Input
            id={inputId}
            value={sourceHome}
            onChange={(event) => {
              setSourceHome(event.target.value)
              setPickedPath(false)
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
            {t('accounts.homeImport.browse', 'Browse…')}
          </Button>
        </div>
        <p id={`${inputId}-hint`} className="text-xs text-muted-foreground">
          {t('accounts.homeImport.hint', 'Choose the account home folder, not an individual file.')}
        </p>
        {error && (
          <p id={`${inputId}-error`} role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}
      </div>
      <Button type="submit" disabled={unavailable || !sourceHome.trim()} className="w-full">
        {busy && <Loader2 className="size-4 animate-spin" />}
        {t('accounts.homeImport.submit', 'Import account')}
      </Button>
    </form>
  )
}

export function AccountHomeImport<T>(props: ImportProps<T>) {
  const t = useTranslate()
  const [open, setOpen] = useState(false)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="xs" disabled={props.disabled}>
          <FolderOpen className="size-3" />
          {t('accounts.homeImport.trigger', 'Import from home…')}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        aria-label={t('accounts.homeImport.title', 'Import {{provider}} account', {
          provider: props.provider
        })}
        className="w-80 max-w-[calc(100vw-2rem)]"
      >
        <div className="p-4">
          <AccountHomeImportForm {...props} onImported={() => setOpen(false)} />
        </div>
      </PopoverContent>
    </Popover>
  )
}
