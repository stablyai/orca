// Minimal local-desktop configuration UI for the triage provider's OpenAI
// API key. Mirrors OpenAiTranscriptionKeyDialog.tsx's shape and its safety
// property: the key itself never touches Zustand, logs, or any persisted
// renderer state — it lives only in this component's local `apiKeyDraft`
// state until handed to the desktop-only IPC save call, which never returns
// it back. Reachable only from AuditedTaskDetail's blocked/provider_unavailable
// state; hidden entirely in the paired web client (see
// audited-workflow-availability.ts — this dialog is never rendered there
// because AuditedTaskDetail itself is gated).
import { Loader2, Lock } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { translate } from '@/i18n/i18n'

type AuditedTriageApiKeyDialogProps = {
  open: boolean
  configured: boolean
  apiKeyDraft: string
  pending: boolean
  onOpenChange: (open: boolean) => void
  onApiKeyDraftChange: (value: string) => void
  onSave: () => void
  onClear: () => void
}

export function AuditedTriageApiKeyDialog({
  open,
  configured,
  apiKeyDraft,
  pending,
  onOpenChange,
  onApiKeyDraftChange,
  onSave,
  onClear
}: AuditedTriageApiKeyDialogProps): React.JSX.Element {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {translate(
              'auto.components.auditedWorkflow.AuditedTriageApiKeyDialog.title',
              'Audited Workflow Triage'
            )}
          </DialogTitle>
          <DialogDescription>
            {translate(
              'auto.components.auditedWorkflow.AuditedTriageApiKeyDialog.description',
              'Task title and description are sent to OpenAI only when you start triage.'
            )}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="audited-triage-api-key">
            {translate(
              'auto.components.auditedWorkflow.AuditedTriageApiKeyDialog.label',
              'API Key'
            )}
          </Label>
          <Input
            id="audited-triage-api-key"
            type="password"
            value={apiKeyDraft}
            placeholder={
              configured
                ? translate(
                    'auto.components.auditedWorkflow.AuditedTriageApiKeyDialog.configuredPlaceholder',
                    'API key configured'
                  )
                : translate(
                    'auto.components.auditedWorkflow.AuditedTriageApiKeyDialog.emptyPlaceholder',
                    'sk-...'
                  )
            }
            disabled={pending}
            onChange={(event) => onApiKeyDraftChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && apiKeyDraft.trim()) {
                onSave()
              }
            }}
          />
        </div>
        <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground/70">
          <Lock className="size-3 shrink-0" />
          {translate(
            'auto.components.auditedWorkflow.AuditedTriageApiKeyDialog.storageNote',
            'Local runtime keys are stored in ~/.orca using Electron encrypted storage when available.'
          )}
        </p>
        <DialogFooter>
          {configured && (
            <Button variant="outline" disabled={pending} onClick={onClear}>
              {translate(
                'auto.components.auditedWorkflow.AuditedTriageApiKeyDialog.clear',
                'Clear Key'
              )}
            </Button>
          )}
          <Button disabled={pending || !apiKeyDraft.trim()} onClick={onSave}>
            {pending ? <Loader2 className="size-4 animate-spin" /> : null}
            {translate(
              'auto.components.auditedWorkflow.AuditedTriageApiKeyDialog.save',
              'Save Key'
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
