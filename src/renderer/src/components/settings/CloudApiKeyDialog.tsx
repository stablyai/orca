import { Loader2, Lock } from 'lucide-react'
import { Button } from '../ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '../ui/dialog'
import { Input } from '../ui/input'
import { Label } from '../ui/label'

// Shared presentational dialog for cloud STT provider API keys. Each provider
// wraps this and supplies its own already-translated copy so localization keys
// stay literal in the per-provider source (catalog parity is verified in lint).
type CloudApiKeyDialogProps = {
  open: boolean
  configured: boolean
  apiKeyDraft: string
  pending: boolean
  onOpenChange: (open: boolean) => void
  onApiKeyDraftChange: (value: string) => void
  onSave: () => void
  onClear: () => void
  inputId: string
  title: string
  description: string
  apiKeyLabel: string
  placeholder: string
  storageNote: string
  clearLabel: string
  saveLabel: string
}

export function CloudApiKeyDialog({
  open,
  configured,
  apiKeyDraft,
  pending,
  onOpenChange,
  onApiKeyDraftChange,
  onSave,
  onClear,
  inputId,
  title,
  description,
  apiKeyLabel,
  placeholder,
  storageNote,
  clearLabel,
  saveLabel
}: CloudApiKeyDialogProps): React.JSX.Element {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor={inputId}>{apiKeyLabel}</Label>
          <Input
            id={inputId}
            type="password"
            value={apiKeyDraft}
            placeholder={placeholder}
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
          {storageNote}
        </p>
        <DialogFooter>
          {configured && (
            <Button variant="outline" disabled={pending} onClick={onClear}>
              {clearLabel}
            </Button>
          )}
          <Button disabled={pending || !apiKeyDraft.trim()} onClick={onSave}>
            {pending ? <Loader2 className="size-4 animate-spin" /> : null}
            {saveLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
