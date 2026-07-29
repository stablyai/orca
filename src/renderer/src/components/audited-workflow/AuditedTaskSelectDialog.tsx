// Custom-task selection dialog for Phase 1. Roadmap-sourced selection is
// added in Phase 9 (see plan §15); this dialog only offers the "custom task"
// path today, matching selectTask's current 'custom' source support.
import { useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { useAppStore } from '@/store'
import { RISK_LEVELS, type RiskLevel } from '../../../../shared/audited-workflow-types'
import { translate } from '@/i18n/i18n'
import { getSelectTaskErrorMessage } from './audited-workflow-error-messages'

type AuditedTaskSelectDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
}

const RISK_LABELS: Record<RiskLevel, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High'
}

export function AuditedTaskSelectDialog({
  open,
  onOpenChange
}: AuditedTaskSelectDialogProps): React.JSX.Element {
  const repos = useAppStore((s) => s.repos)
  const createAuditedTask = useAppStore((s) => s.createAuditedTask)

  const [repoId, setRepoId] = useState<string>('')
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [risk, setRisk] = useState<RiskLevel>('low')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const canSubmit = repoId.trim().length > 0 && title.trim().length > 0 && !submitting

  const handleSubmit = async (): Promise<void> => {
    if (!canSubmit) {
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      const result = await createAuditedTask({
        repoId,
        source: 'custom',
        title: title.trim(),
        description,
        risk
      })
      if (!result.ok) {
        // Why: reason codes only — never a raw exception message, path, or
        // command string. See audited-workflow-error-messages.ts.
        setError(getSelectTaskErrorMessage(result.reasonCode))
        return
      }
      setTitle('')
      setDescription('')
      setRisk('low')
      onOpenChange(false)
    } catch {
      // Why: an unexpected IPC-transport-level failure still must not leak
      // its raw message to the renderer.
      setError(getSelectTaskErrorMessage('internal_error'))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {translate(
              'auto.components.auditedWorkflow.AuditedTaskSelectDialog.title',
              'New Audited Task'
            )}
          </DialogTitle>
          <DialogDescription>
            {translate(
              'auto.components.auditedWorkflow.AuditedTaskSelectDialog.description',
              'Creates a task record only. No worktree is provisioned and no agent runs yet.'
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="audited-task-repo">
              {translate(
                'auto.components.auditedWorkflow.AuditedTaskSelectDialog.repoLabel',
                'Repository'
              )}
            </Label>
            <Select value={repoId} onValueChange={setRepoId}>
              <SelectTrigger id="audited-task-repo" className="w-full">
                <SelectValue
                  placeholder={translate(
                    'auto.components.auditedWorkflow.AuditedTaskSelectDialog.repoPlaceholder',
                    'Select a repository'
                  )}
                />
              </SelectTrigger>
              <SelectContent>
                {repos.map((repo) => (
                  <SelectItem key={repo.id} value={repo.id}>
                    {repo.displayName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="audited-task-title">
              {translate(
                'auto.components.auditedWorkflow.AuditedTaskSelectDialog.titleLabel',
                'Title'
              )}
            </Label>
            <Input
              id="audited-task-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={200}
              placeholder={translate(
                'auto.components.auditedWorkflow.AuditedTaskSelectDialog.titlePlaceholder',
                'Short, single-line task title'
              )}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="audited-task-description">
              {translate(
                'auto.components.auditedWorkflow.AuditedTaskSelectDialog.descriptionLabel',
                'Description'
              )}
            </Label>
            <textarea
              id="audited-task-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={20_000}
              rows={4}
              className="w-full resize-none rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
              placeholder={translate(
                'auto.components.auditedWorkflow.AuditedTaskSelectDialog.descriptionPlaceholder',
                'What should the task accomplish?'
              )}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="audited-task-risk">
              {translate(
                'auto.components.auditedWorkflow.AuditedTaskSelectDialog.riskLabel',
                'Risk'
              )}
            </Label>
            <Select value={risk} onValueChange={(v) => setRisk(v as RiskLevel)}>
              <SelectTrigger id="audited-task-risk" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {RISK_LEVELS.map((level) => (
                  <SelectItem key={level} value={level}>
                    {RISK_LABELS[level]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {error ? <p className="text-xs text-destructive">{error}</p> : null}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={submitting}>
            {translate('auto.components.auditedWorkflow.AuditedTaskSelectDialog.cancel', 'Cancel')}
          </Button>
          <Button onClick={handleSubmit} disabled={!canSubmit}>
            {translate('auto.components.auditedWorkflow.AuditedTaskSelectDialog.create', 'Create')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
