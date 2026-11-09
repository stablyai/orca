import { useState } from 'react'
import { Github, Loader2, RotateCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useTranslate } from '@/i18n/use-translate'
import type { CloudApiInstallation, Routine } from '../../../../../shared/cloud-api/cloud-api-types'
import { CopyValueButton } from './cloud-api-parts'
import { OneTimeSecret, OneTimeSecretDoneButton } from './OneTimeSecret'

export function GithubAppHint({
  installations
}: {
  installations: readonly CloudApiInstallation[] | null
}): React.JSX.Element | null {
  const t = useTranslate()
  if (installations === null) {
    return null
  }
  return (
    <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
      <Github className="mt-0.5 size-3.5 shrink-0" aria-hidden />
      {installations.length > 0
        ? t(
            'auto.components.settings.cloudRoutines.editor.appInstalled',
            'The Orca Cloud GitHub App can reach repositories in {{value0}}.',
            { value0: installations.map((installation) => installation.account).join(', ') }
          )
        : t(
            'auto.components.settings.cloudRoutines.editor.appMissing',
            'Install the Orca Cloud GitHub App on your repositories so routines can clone private code, comment and open PRs.'
          )}
    </p>
  )
}

export function WebhookTriggerInfo({
  routine,
  rotated,
  rotating,
  onAskRotate,
  onCancelRotate,
  onRotate
}: {
  routine: Routine | null
  rotated: string | null
  rotating: 'idle' | 'confirm' | 'busy'
  onAskRotate: () => void
  onCancelRotate: () => void
  onRotate: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const hint = routine?.trigger.kind === 'webhook' ? routine.trigger.urlHint : null
  if (!routine || routine.trigger.kind !== 'webhook') {
    return (
      <p className="text-xs leading-5 text-muted-foreground">
        {t(
          'auto.components.settings.cloudRoutines.editor.webhookNew',
          'After you save, Orca shows a secret URL once. Send a POST to it from CI, Zapier or any script to start a run; the JSON body is passed to the agent.'
        )}
      </p>
    )
  }
  if (rotated) {
    return <WebhookUrlField url={rotated} />
  }
  return (
    <div className="grid gap-2.5">
      <p className="text-xs leading-5 text-muted-foreground">
        {t(
          'auto.components.settings.cloudRoutines.editor.webhookExisting',
          'POST to this routine’s secret URL to start a run. Orca never shows the full URL again; rotate it if you lost it or it leaked.'
        )}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        {hint ? (
          <code className="rounded border border-border/70 bg-muted/40 px-1.5 py-0.5 font-mono text-xs">
            {hint}
          </code>
        ) : null}
        {rotating === 'confirm' ? (
          <div role="group" className="flex items-center gap-1.5">
            <span className="text-xs text-foreground">
              {t(
                'auto.components.settings.cloudRoutines.editor.rotateConfirm',
                'The current URL stops working. Rotate?'
              )}
            </span>
            {/* Focus moves here: the button that opened the confirm just unmounted. */}
            <Button type="button" variant="ghost" size="xs" onClick={onCancelRotate} autoFocus>
              {t('auto.components.settings.cloudApi.cancel', 'Cancel')}
            </Button>
            <Button type="button" variant="destructive-chip" size="xs" onClick={onRotate}>
              {t('auto.components.settings.cloudRoutines.editor.rotateAction', 'Rotate URL')}
            </Button>
          </div>
        ) : (
          <Button
            type="button"
            variant="outline"
            size="xs"
            onClick={onAskRotate}
            disabled={rotating === 'busy'}
          >
            {rotating === 'busy' ? (
              <Loader2 className="animate-spin motion-reduce:animate-none" />
            ) : (
              <RotateCw />
            )}
            {t('auto.components.settings.cloudRoutines.editor.rotate', 'Rotate URL…')}
          </Button>
        )}
      </div>
    </div>
  )
}

function WebhookUrlField({
  url,
  onCopied
}: {
  url: string
  onCopied?: () => void
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <OneTimeSecret
      label={t('auto.components.settings.cloudRoutines.webhook.label', 'Webhook URL')}
      value={url}
      copyLabel={t('auto.components.settings.cloudRoutines.webhook.copy', 'Copy webhook URL')}
      warningTitle={t(
        'auto.components.settings.cloudRoutines.webhook.onceTitle',
        'This is the only time Orca shows this URL.'
      )}
      warningBody={t(
        'auto.components.settings.cloudRoutines.webhook.onceBody',
        'Anyone who has it can start this routine. Store it as a secret in the system that calls it.'
      )}
      onCopied={onCopied}
    />
  )
}

export function WebhookUrlStep({
  url,
  onDone
}: {
  url: string
  onDone: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const [copied, setCopied] = useState(false)
  const curl = `curl -X POST -H 'content-type: application/json' -d '{"ref":"main"}' ${url}`
  return (
    <div className="grid gap-5">
      <DialogHeader>
        <DialogTitle>
          {t('auto.components.settings.cloudRoutines.webhook.title', 'Routine created')}
        </DialogTitle>
        <DialogDescription>
          {t(
            'auto.components.settings.cloudRoutines.webhook.description',
            'Send a POST request to this URL to start a run. The request body is passed to the agent.'
          )}
        </DialogDescription>
      </DialogHeader>
      <WebhookUrlField url={url} onCopied={() => setCopied(true)} />
      <div className="grid gap-1.5">
        <p className="text-xs font-medium">
          {t('auto.components.settings.cloudRoutines.webhook.example', 'Try it')}
        </p>
        <div className="flex items-start gap-2">
          <code className="min-w-0 flex-1 rounded-md border border-border/70 bg-muted/30 px-3 py-2 font-mono text-[11px] leading-5 break-all text-muted-foreground">
            {curl}
          </code>
          <CopyValueButton
            value={curl}
            label={t(
              'auto.components.settings.cloudRoutines.webhook.copyCurl',
              'Copy curl command'
            )}
          />
        </div>
      </div>
      <DialogFooter>
        <OneTimeSecretDoneButton copied={copied} onDone={onDone} />
      </DialogFooter>
    </div>
  )
}
