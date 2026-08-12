import { useEffect, useRef, useState } from 'react'
import { ExternalLink } from 'lucide-react'
import { toast } from 'sonner'
import type { ClinePassCredentialsStatus } from '../../../../shared/clinepass-credentials'
import { translate } from '@/i18n/i18n'
import { AgentIcon } from '@/lib/agent-catalog'
import { ClinePassApiKeyForm } from './ClinePassApiKeyForm'
import { ClinePassCredentialStatus } from './ClinePassCredentialStatus'

const CLINE_API_AUTH_DOCS_URL = 'https://docs.cline.bot/api/authentication'

export function ClinePassAccountsSection(): React.JSX.Element {
  const [status, setStatus] = useState<ClinePassCredentialsStatus | null>(null)
  const [statusLoading, setStatusLoading] = useState(true)
  const [statusLoadFailed, setStatusLoadFailed] = useState(false)
  const [apiKeyDraft, setApiKeyDraft] = useState('')
  const [draftInvalid, setDraftInvalid] = useState(false)
  const [credentialBusy, setCredentialBusy] = useState(false)
  const credentialBusyRef = useRef(false)

  useEffect(() => {
    let active = true
    void window.api.clinePassCredentials
      .getStatus()
      .then(({ configured, source }) => {
        if (active) {
          setStatus({ configured, source })
        }
      })
      .catch(() => {
        if (!active) {
          return
        }
        setStatusLoadFailed(true)
        toast.error(
          translate(
            'auto.components.settings.ClinePassAccountsSection.3f06b1e71d',
            'ClinePass credential status could not be loaded.'
          )
        )
      })
      .finally(() => {
        if (active) {
          setStatusLoading(false)
        }
      })

    return () => {
      active = false
    }
  }, [])

  const beginCredentialAction = (): boolean => {
    if (credentialBusyRef.current) {
      return false
    }
    credentialBusyRef.current = true
    setCredentialBusy(true)
    return true
  }

  const endCredentialAction = (): void => {
    credentialBusyRef.current = false
    setCredentialBusy(false)
  }

  const saveApiKey = async (): Promise<void> => {
    const apiKey = apiKeyDraft.trim()
    if (!apiKey) {
      setDraftInvalid(true)
      toast.error(
        translate(
          'auto.components.settings.ClinePassAccountsSection.f036f412e9',
          'ClinePass API key is required.'
        )
      )
      return
    }
    if (!beginCredentialAction()) {
      return
    }

    try {
      const next = await window.api.clinePassCredentials.saveApiKey(apiKey)
      if (!next.configured || next.source !== 'stored') {
        throw new Error('save failed')
      }
      setStatus({ configured: next.configured, source: next.source })
      setStatusLoadFailed(false)
      setApiKeyDraft('')
      setDraftInvalid(false)
      toast.success(
        translate(
          'auto.components.settings.ClinePassAccountsSection.738e1fe094',
          'ClinePass API key saved.'
        )
      )
    } catch {
      toast.error(
        translate(
          'auto.components.settings.ClinePassAccountsSection.d8358b48f6',
          'ClinePass API key could not be saved. Check the key and try again.'
        )
      )
    } finally {
      endCredentialAction()
    }
  }

  const clearApiKey = async (): Promise<void> => {
    if (status?.source !== 'stored' || !beginCredentialAction()) {
      return
    }

    try {
      const next = await window.api.clinePassCredentials.clearApiKey()
      if (next.source === 'stored') {
        throw new Error('clear failed')
      }
      setStatus({ configured: next.configured, source: next.source })
      setStatusLoadFailed(false)
      toast.success(
        translate(
          'auto.components.settings.ClinePassAccountsSection.902abdf7f8',
          'Stored ClinePass API key forgotten.'
        )
      )
    } catch {
      toast.error(
        translate(
          'auto.components.settings.ClinePassAccountsSection.8c8eb65703',
          'Stored ClinePass API key could not be forgotten. Try again.'
        )
      )
    } finally {
      endCredentialAction()
    }
  }

  const handleDraftChange = (value: string): void => {
    setApiKeyDraft(value)
    if (draftInvalid && value.trim()) {
      setDraftInvalid(false)
    }
  }

  const source = status?.source ?? 'none'

  return (
    <section id="accounts-clinepass" className="space-y-4 scroll-mt-6">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <h3 className="flex items-center gap-2 text-sm font-semibold">
            <AgentIcon agent="cline" size={16} />
            {translate('auto.components.settings.ClinePassAccountsSection.02498819c4', 'ClinePass')}
          </h3>
          <p className="text-xs text-muted-foreground">
            {translate(
              'auto.components.settings.ClinePassAccountsSection.71c914cff5',
              'Track included ClinePass subscription quota across 5-hour, weekly, and monthly windows.'
            )}
          </p>
        </div>
        <a
          href={CLINE_API_AUTH_DOCS_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex shrink-0 items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          {translate(
            'auto.components.settings.ClinePassAccountsSection.7b9e5f6452',
            'API key docs'
          )}
          <ExternalLink className="size-3" />
        </a>
      </div>

      <ClinePassCredentialStatus
        status={status}
        loading={statusLoading}
        loadFailed={statusLoadFailed}
      />

      <ClinePassApiKeyForm
        source={source}
        draft={apiKeyDraft}
        draftInvalid={draftInvalid}
        busy={credentialBusy}
        statusLoading={statusLoading}
        onDraftChange={handleDraftChange}
        onSave={saveApiKey}
        onClear={clearApiKey}
      />
    </section>
  )
}
