// Settings section for the audited Codex provider key.
//
// TRANCHE 1 SURFACE: status plus a key dialog. There is deliberately NO provider
// picker and NO base-URL input — the endpoint lives in a main-owned registry the
// renderer cannot read, and selecting a provider today could only produce
// `credential_delivery_unavailable`. A picker would advertise a capability that
// does not exist; it lands with the credential-delivery change.
//
// The key itself never touches Zustand, logs, or any persisted renderer state:
// it lives in this component's local draft until handed to the desktop-only IPC
// save call, which never returns it. Saving the key IS selecting the provider —
// main derives selection from the record's presence.
//
// This component never sends `auditedCodexProvider` through settings:set. The
// only provider writer is the main-process key path.
import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { AuditedTriageApiKeyDialog } from './AuditedTriageApiKeyDialog'

export function AuditedCodexProviderSection(): React.JSX.Element {
  const [keyConfigured, setKeyConfigured] = useState(false)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [apiKeyDraft, setApiKeyDraft] = useState('')
  const [pending, setPending] = useState(false)

  const refreshStatus = useCallback(async (): Promise<void> => {
    try {
      const status = await window.api.auditedWorkflow.getCodexProviderStatus()
      setKeyConfigured(status.keyConfigured)
    } catch {
      // The handler is written to always resolve with a safe status rather than
      // reject; this is defense-in-depth against an unexpected preload failure.
      setKeyConfigured(false)
    }
  }, [])

  useEffect(() => {
    void refreshStatus()
  }, [refreshStatus])

  const handleSave = async (): Promise<void> => {
    setPending(true)
    try {
      const status = await window.api.auditedWorkflow.saveCodexProviderKey({
        apiKey: apiKeyDraft
      })
      setKeyConfigured(status.keyConfigured)
      setApiKeyDraft('')
      setDialogOpen(false)
    } catch {
      // Same rationale as above — never surface a raw rejection.
    } finally {
      setPending(false)
    }
  }

  const handleClear = async (): Promise<void> => {
    setPending(true)
    try {
      const status = await window.api.auditedWorkflow.clearCodexProviderKey()
      setKeyConfigured(status.keyConfigured)
      setApiKeyDraft('')
      setDialogOpen(false)
    } catch {
      // Same rationale as above.
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="mt-4">
      <div className="text-sm font-medium text-foreground">
        {translate('auto.components.auditedWorkflow.provider.title', 'Audited Codex provider')}
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        {keyConfigured
          ? translate(
              'auto.components.auditedWorkflow.provider.configured',
              'A provider key is configured. Orca cannot yet deliver it securely, so plan audits still use the default provider settings.'
            )
          : translate(
              'auto.components.auditedWorkflow.provider.notConfigured',
              'No provider key configured. Plan audits use the default provider settings.'
            )}
      </p>
      <div className="mt-2">
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            setApiKeyDraft('')
            void refreshStatus()
            setDialogOpen(true)
          }}
        >
          {translate(
            'auto.components.auditedWorkflow.provider.configureKey',
            'Configure Provider Key'
          )}
        </Button>
      </div>

      <AuditedTriageApiKeyDialog
        open={dialogOpen}
        configured={keyConfigured}
        apiKeyDraft={apiKeyDraft}
        pending={pending}
        onOpenChange={setDialogOpen}
        onApiKeyDraftChange={setApiKeyDraft}
        onSave={() => void handleSave()}
        onClear={() => void handleClear()}
      />
    </div>
  )
}
