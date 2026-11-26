import { useState, useSyncExternalStore } from 'react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter
} from '@/components/ui/dialog'
import { useTranslate } from '@/i18n/use-translate'
import { recomputeOn } from '@/lib/recompute-on'
import { PipelineToggle } from './PipelineFormFields'
import { pipelineRetentionVersion, subscribePipelineRetention } from './pipeline-retention-events'
import {
  pipelineRetainedInputs,
  readPipelineRetainedInput,
  releasePipelineRetainedInput
} from './pipeline-retained-inputs'

export function PipelineRetainedInputs() {
  const t = useTranslate()
  const version = useSyncExternalStore(subscribePipelineRetention, pipelineRetentionVersion)
  const [open, setOpen] = useState(false)
  const [refresh, setRefresh] = useState(0)
  const [selected, setSelected] = useState<{ key: string; text: string }>()
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState('')
  const entries = recomputeOn([version, refresh, open], pipelineRetainedInputs)
  const current = entries.find((entry) => entry.key === selected?.key)
  const inspect = (key: string) => {
    setError('')
    setCopied(false)
    try {
      setSelected({ key, text: readPipelineRetainedInput(key) })
    } catch (error) {
      setError(String(error))
    }
  }
  const copy = async () => {
    if (!selected) {
      return
    }
    try {
      await window.api.ui.writeClipboardText(selected.text)
    } catch (error) {
      setError(String(error))
    }
  }
  const release = () => {
    if (!selected) {
      return
    }
    try {
      releasePipelineRetainedInput(selected.key, copied)
      setSelected(undefined)
      setCopied(false)
      setError('')
    } catch (error) {
      setError(String(error))
    }
  }
  return (
    <>
      <Button
        variant="outline"
        onClick={() => {
          setOpen(true)
          setRefresh((value) => value + 1)
        }}
      >
        {t('pipelines.recoverSavedText', 'Recover saved text')}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent surface="security">
          <DialogHeader>
            <DialogTitle>
              {t('pipelines.savedTextAndActions', 'Saved text and unfinished actions')}
            </DialogTitle>
            <DialogDescription>
              {t(
                'pipelines.retainedMeaning',
                'Recover your draft or message when editing was interrupted. You can copy its text before removing the local recovery copy.'
              )}
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-96 space-y-3 overflow-y-auto scrollbar-sleek">
            {entries.map((entry) => (
              <Button
                key={entry.key}
                variant="outline"
                className="h-auto w-full min-w-0 justify-start whitespace-normal"
                onClick={() => inspect(entry.key)}
              >
                <span className="min-w-0 break-all text-left">
                  <span className="block font-medium">
                    {entry.title ??
                      (entry.runId
                        ? t('pipelines.execution', 'Pipeline run')
                        : t('pipelines.draft', 'Draft'))}
                  </span>
                  <span className="mt-1 block text-xs text-muted-foreground">
                    {entry.hasPending
                      ? t('pipelines.actionResultUnknown', 'An action result needs checking')
                      : t('pipelines.localRecoveryCopy', 'Local recovery copy')}
                  </span>
                </span>
              </Button>
            ))}
            {!entries.length && (
              <p className="text-sm">{t('pipelines.noRetainedInput', 'No retained input.')}</p>
            )}
            {selected && (
              <div className="space-y-2">
                <p className="text-sm">
                  {t(
                    'pipelines.recoveryCopyMeaning',
                    'This copy contains your text and the references needed to check unfinished actions. Removing it does not cancel a remote action.'
                  )}
                </p>
                <Textarea
                  aria-label={t(
                    'pipelines.retainedExport',
                    'Retained input and original request identities'
                  )}
                  value={selected.text}
                  readOnly
                  rows={8}
                />
                <Button variant="outline" onClick={() => void copy()}>
                  {t('pipelines.copyRetained', 'Copy retained input')}
                </Button>
                {current?.active && (
                  <p className="text-sm">
                    {t(
                      'pipelines.closeRetainedView',
                      'This copy is still in use by an open run or editor. Close that view before removing the recovery copy.'
                    )}
                  </p>
                )}
                {current?.hasPending && (
                  <p className="text-sm">
                    {t(
                      'pipelines.retainUnknownRequest',
                      'An action may already have been applied. Check its result using the original reference before trying it again.'
                    )}
                  </p>
                )}
                <PipelineToggle checked={copied} onChange={setCopied}>
                  {t(
                    'pipelines.savedRetainedCopy',
                    'I have saved the text and original request identities I need.'
                  )}
                </PipelineToggle>
                <Button
                  variant="outline"
                  disabled={!copied || !current || current.active}
                  onClick={release}
                >
                  {t('pipelines.removeRecoveryCopy', 'Remove recovery copy')}
                </Button>
              </div>
            )}
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRefresh((value) => value + 1)}>
              {t('pipelines.refreshRetained', 'Refresh retained input')}
            </Button>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              {t('pipelines.close', 'Close')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
