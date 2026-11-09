import { useId } from 'react'
import { Github, Loader2, RotateCw, ShieldAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { useTranslate } from '@/i18n/use-translate'
import type { CloudApiInstallation, Routine } from '../../../../../shared/cloud-api/cloud-api-types'
import { CopyValueButton } from './cloud-api-parts'

const CURL_EXAMPLE = `curl -X POST -H 'content-type: application/json' -d '{"ref":"main"}' <url>`

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
            <Button type="button" variant="ghost" size="xs" onClick={onCancelRotate}>
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

function WebhookUrlField({ url }: { url: string }): React.JSX.Element {
  const t = useTranslate()
  const ids = useId()
  return (
    <div className="grid gap-2.5">
      <div
        role="note"
        className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-2.5 py-2 text-xs leading-5"
      >
        <ShieldAlert
          className="mt-0.5 size-3.5 shrink-0 text-amber-600 dark:text-amber-400"
          aria-hidden
        />
        {t(
          'auto.components.settings.cloudRoutines.webhook.once',
          'Copy this URL now. Orca will not show it again, and anyone who has it can start this routine.'
        )}
      </div>
      <div className="flex items-center gap-2">
        <label htmlFor={`${ids}-url`} className="sr-only">
          {t('auto.components.settings.cloudRoutines.webhook.label', 'Webhook URL')}
        </label>
        <Input
          id={`${ids}-url`}
          readOnly
          value={url}
          spellCheck={false}
          className="font-mono text-xs"
          onClick={(event) => event.currentTarget.select()}
        />
        <CopyValueButton
          value={url}
          variant="default"
          size="sm"
          label={t('auto.components.settings.cloudRoutines.webhook.copy', 'Copy webhook URL')}
        />
      </div>
    </div>
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
      <WebhookUrlField url={url} />
      <code className="block overflow-x-auto rounded-md border border-border/70 bg-muted/30 px-3 py-2 font-mono text-[11px] leading-5 text-muted-foreground">
        {CURL_EXAMPLE}
      </code>
      <DialogFooter>
        <Button type="button" size="sm" onClick={onDone}>
          {t('auto.components.settings.cloudApi.secret.done', 'Done')}
        </Button>
      </DialogFooter>
    </div>
  )
}
