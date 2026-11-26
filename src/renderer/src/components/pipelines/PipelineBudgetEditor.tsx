import { useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { useTranslate } from '@/i18n/use-translate'
import type { usePipelineRun } from './use-pipeline-run'
import type { PipelineRunRead } from './pipeline-run-read'
import { PipelineTextField } from './PipelineFormFields'
import { pipelineBudgetExtension } from '../../../../shared/pipelines/v2/pipeline-v2-budget-extension'

export function PipelineBudgetEditor({ model }: { model: ReturnType<typeof usePipelineRun> }) {
  const t = useTranslate()
  const [shown, setShown] = useState<PipelineRunRead>()
  const [invocations, setInvocations] = useState('')
  const [discussions, setDiscussions] = useState('')
  const [returns, setReturns] = useState('')
  const read = model.read
  if (!read) {
    return null
  }
  const values = [Number(invocations), Number(discussions), Number(returns)]
  const limits = shown?.status.run.effectiveLimits
  const valid =
    !model.synchronization &&
    limits &&
    values.every(Number.isSafeInteger) &&
    values[0] >= limits.maxInvocations &&
    values[0] <= 256 &&
    values[1] >= limits.maxDiscussionTurns &&
    values[1] <= 64 &&
    values[2] >= limits.maxReentries &&
    values[2] <= 20 &&
    (values[0] > limits.maxInvocations ||
      values[1] > limits.maxDiscussionTurns ||
      values[2] > limits.maxReentries)
  return (
    <>
      <Button
        variant="outline"
        disabled={
          model.busy ||
          Boolean(model.pending) ||
          !['waiting_owner', 'paused'].includes(read.status.run.state) ||
          Boolean(
            read.status.run.currentInvocation &&
            read.status.run.currentInvocation.state !== 'settled'
          )
        }
        onClick={() => {
          setShown(read)
          setInvocations(String(read.status.run.effectiveLimits.maxInvocations))
          setDiscussions(String(read.status.run.effectiveLimits.maxDiscussionTurns))
          setReturns(String(read.status.run.effectiveLimits.maxReentries))
        }}
      >
        {t('pipelines.adjustBudget', 'Increase limits')}
      </Button>
      <Dialog
        open={Boolean(shown)}
        onOpenChange={(open) => {
          if (!open) {
            setShown(undefined)
          }
        }}
      >
        <DialogContent surface="security">
          <DialogHeader>
            <DialogTitle>{t('pipelines.adjustBudget', 'Increase limits')}</DialogTitle>
            <DialogDescription>
              {t(
                'pipelines.budgetMeaning',
                'Increase only the limits needed for this run. This does not accept a result or change the template.'
              )}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            {limits?.reentryStageId && (
              <p className="text-sm">
                {t('pipelines.returnBudgetTarget', 'Return limit for {{stage}}', {
                  stage:
                    shown?.definition.stages.find((stage) => stage.id === limits.reentryStageId)
                      ?.title ?? limits.reentryStageId
                })}
              </p>
            )}
            <PipelineTextField
              label={t('pipelines.invocationsHardLimit', 'Agent turns (maximum 256)')}
              value={invocations}
              onChange={setInvocations}
            />
            <PipelineTextField
              label={t(
                'pipelines.discussionHardLimit',
                'Discussion turns for this visit (maximum 64)'
              )}
              value={discussions}
              onChange={setDiscussions}
            />
            <PipelineTextField
              label={t('pipelines.returnHardLimit', 'Returns to this stage (maximum 20)')}
              value={returns}
              onChange={setReturns}
            />
          </div>
          {model.actionError && (
            <p role="alert" className="text-sm text-destructive">
              {model.actionError}
            </p>
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setShown(undefined)}>
              {t('pipelines.cancel', 'Cancel')}
            </Button>
            <Button
              disabled={!valid || model.busy || Boolean(model.pending)}
              onClick={() => {
                if (!shown || !limits) {
                  return
                }
                void model.resource
                  .act(
                    {
                      kind: 'extend_budget',
                      extension: pipelineBudgetExtension(shown.status.run, {
                        maxInvocations: values[0],
                        maxDiscussionTurns: values[1],
                        maxReentries: values[2]
                      })
                    },
                    shown
                  )
                  .then((confirmed) => {
                    if (confirmed) {
                      setShown(undefined)
                    }
                  })
              }}
            >
              {t('pipelines.confirm', 'Confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
