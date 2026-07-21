import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Loader2, Lock, LockOpen, ShieldCheck } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { SearchableSetting } from './SearchableSetting'

type CredentialStatus = { configured: boolean }

type UseProviderSecretCredentialOptions = {
  getStatus: () => Promise<CredentialStatus>
  save: (credential: string) => Promise<CredentialStatus>
  clear: () => Promise<CredentialStatus>
  requiredMessage: string
  notSavedMessage: string
  savedMessage: string
  updateFailedMessage: string
  loadFailureLogLabel: string
  onChanged: () => void
}

export type ProviderSecretCredentialState = {
  busy: boolean
  configured: boolean
  draft: string
  setDraft: (value: string) => void
  saveCredential: () => Promise<void>
  clearCredential: () => Promise<void>
}

export function useProviderSecretCredential({
  getStatus,
  save,
  clear,
  requiredMessage,
  notSavedMessage,
  savedMessage,
  updateFailedMessage,
  loadFailureLogLabel,
  onChanged
}: UseProviderSecretCredentialOptions): ProviderSecretCredentialState {
  const [draft, setDraft] = useState('')
  const [configured, setConfigured] = useState(false)
  const [busy, setBusy] = useState(false)
  const credentialMutationGenerationRef = useRef(0)

  useEffect(() => {
    let active = true
    const generation = credentialMutationGenerationRef.current
    void getStatus()
      .then((status) => {
        // Why: an initial status read may resolve after a save/clear action;
        // never let that stale snapshot overwrite the mutation result.
        if (active && generation === credentialMutationGenerationRef.current) {
          setConfigured(status.configured)
        }
      })
      .catch((error: unknown) => {
        console.error(loadFailureLogLabel, error)
      })
    return () => {
      active = false
    }
  }, [getStatus, loadFailureLogLabel])

  const saveCredential = useCallback(async (): Promise<void> => {
    const trimmed = draft.trim()
    if (!trimmed) {
      toast.error(requiredMessage)
      return
    }
    credentialMutationGenerationRef.current += 1
    setBusy(true)
    try {
      const status = await save(trimmed)
      if (!status.configured) {
        throw new Error(notSavedMessage)
      }
      setConfigured(true)
      setDraft('')
      onChanged()
      toast.success(savedMessage)
    } catch (error) {
      toast.error(updateFailedMessage, {
        description: String((error as Error)?.message ?? error)
      })
    } finally {
      setBusy(false)
    }
  }, [draft, notSavedMessage, onChanged, requiredMessage, save, savedMessage, updateFailedMessage])

  const clearCredential = useCallback(async (): Promise<void> => {
    credentialMutationGenerationRef.current += 1
    setBusy(true)
    try {
      const status = await clear()
      setConfigured(status.configured)
      setDraft('')
      onChanged()
    } catch (error) {
      toast.error(updateFailedMessage, {
        description: String((error as Error)?.message ?? error)
      })
    } finally {
      setBusy(false)
    }
  }, [clear, onChanged, updateFailedMessage])

  return { busy, configured, draft, setDraft, saveCredential, clearCredential }
}

type ProviderSecretCredentialProps = {
  state: ProviderSecretCredentialState
  credentialLabel: string
  settingDescription: string
  keywords: string[]
  placeholder: string
  configuredStatusLabel: string
  unconfiguredStatusLabel: string
  storageDescription: string
  savedLabel: string
  notSavedLabel: string
  saveLabel: string
  replaceLabel: string
  forgetLabel: string
  labelAction?: ReactNode
  guidance: ReactNode
  lastRefreshLabel?: string | null
  trailingGuidance?: ReactNode
}

export function ProviderSecretCredential({
  state,
  credentialLabel,
  settingDescription,
  keywords,
  placeholder,
  configuredStatusLabel,
  unconfiguredStatusLabel,
  storageDescription,
  savedLabel,
  notSavedLabel,
  saveLabel,
  replaceLabel,
  forgetLabel,
  labelAction,
  guidance,
  lastRefreshLabel,
  trailingGuidance
}: ProviderSecretCredentialProps): React.JSX.Element {
  const { busy, configured, draft, setDraft, saveCredential, clearCredential } = state

  return (
    <>
      <div
        className={cn(
          'flex items-start gap-3 rounded-lg border bg-muted/20 p-3',
          configured ? 'border-border/60' : 'border-border/40'
        )}
      >
        <ShieldCheck
          className={cn(
            'mt-0.5 size-4 shrink-0',
            configured ? 'text-foreground' : 'text-muted-foreground'
          )}
        />
        <div className="space-y-0.5">
          <p className="text-xs font-medium">
            {configured ? configuredStatusLabel : unconfiguredStatusLabel}
          </p>
          <p className="text-xs text-muted-foreground">{storageDescription}</p>
        </div>
      </div>

      <SearchableSetting
        title={credentialLabel}
        description={settingDescription}
        keywords={keywords}
        className="space-y-2"
      >
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Label>{credentialLabel}</Label>
            <Badge
              variant={configured ? 'secondary' : 'outline'}
              className="h-5 gap-1 rounded-full px-2 text-[10px] font-medium text-muted-foreground"
            >
              {configured ? <Lock className="size-3" /> : <LockOpen className="size-3" />}
              {configured ? savedLabel : notSavedLabel}
            </Badge>
          </div>
          {labelAction}
        </div>
        <div className="flex gap-2">
          <Input
            type="password"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder={placeholder}
            spellCheck={false}
            className="flex-1 text-xs"
          />
          <Button
            size="xs"
            onClick={() => void saveCredential()}
            disabled={busy || !draft.trim()}
            className="h-7 shrink-0 text-xs"
          >
            {busy ? <Loader2 className="size-3 animate-spin" /> : null}
            {configured ? replaceLabel : saveLabel}
          </Button>
          {configured ? (
            <Button
              variant="ghost"
              size="xs"
              onClick={() => void clearCredential()}
              disabled={busy}
              className="h-7 shrink-0 text-xs text-muted-foreground hover:text-foreground"
            >
              {forgetLabel}
            </Button>
          ) : null}
        </div>
        <p className="text-xs text-muted-foreground">{guidance}</p>
        {lastRefreshLabel ? (
          <p className="text-xs text-muted-foreground">{lastRefreshLabel}</p>
        ) : null}
        {trailingGuidance ? (
          <p className="text-xs text-muted-foreground">{trailingGuidance}</p>
        ) : null}
      </SearchableSetting>
    </>
  )
}
