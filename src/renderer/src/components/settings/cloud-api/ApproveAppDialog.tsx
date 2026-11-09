import { useEffect, useId, useState } from 'react'
import { Loader2, Timer, TimerOff } from 'lucide-react'
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
import { cn } from '@/lib/utils'
import type {
  CloudApiApproval,
  CloudApiResult,
  CloudApiScope,
  CreateCloudApiApprovalInput
} from '../../../../../shared/cloud-api/cloud-api-types'
import { SettingsSegmentedControl } from '../form-controls/SettingsFormControls'
import { cloudApiErrorCopy } from './cloud-api-copy'
import { formatCountdown, scopesForPreset } from './cloud-api-format'
import { CloudApiErrorNotice } from './cloud-api-parts'
import { OneTimeSecret, OneTimeSecretDoneButton } from './OneTimeSecret'
import { ScopeSummary } from './ScopeSummary'

/** "Approve an app": a one-time code an MCP client's consent page accepts instead of an API key. */
export function ApproveAppDialog({
  open,
  onOpenChange,
  availableScopes,
  onCreate,
  initialApproval,
  nowForFixture
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  availableScopes: readonly CloudApiScope[]
  onCreate: (input: CreateCloudApiApprovalInput) => Promise<CloudApiResult<CloudApiApproval>>
  initialApproval?: CloudApiApproval
  /** Fixtures pin the clock so the countdown is deterministic. */
  nowForFixture?: number
}): React.JSX.Element {
  const t = useTranslate()
  const ids = useId()
  const [access, setAccess] = useState<'read' | 'full'>('read')
  const [approval, setApproval] = useState<CloudApiApproval | null>(initialApproval ?? null)
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [now, setNow] = useState(() => nowForFixture ?? Date.now())

  useEffect(() => {
    if (!approval || nowForFixture !== undefined) {
      return
    }
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [approval, nowForFixture])

  const remaining = approval ? approval.expiresAt - now : 0
  const expired = approval !== null && remaining <= 0

  const change = (next: boolean): void => {
    if (!next && busy) {
      return
    }
    if (!next) {
      // A code never outlives the dialog that showed it.
      setApproval(null)
      setError(null)
      setCopied(false)
    }
    onOpenChange(next)
  }

  const generate = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    const result = await onCreate(
      access === 'full' ? {} : { scopes: scopesForPreset('read', availableScopes) }
    )
    setBusy(false)
    if (result.ok) {
      setNow(Date.now())
      setApproval(result.data)
    } else {
      setError(cloudApiErrorCopy(result.error, t, result))
    }
  }

  return (
    <Dialog open={open} onOpenChange={change}>
      <DialogContent
        className="sm:max-w-[480px]"
        showCloseButton={!approval || expired}
        onInteractOutside={approval ? (event) => event.preventDefault() : undefined}
        onEscapeKeyDown={approval && !expired ? (event) => event.preventDefault() : undefined}
      >
        <DialogHeader>
          <DialogTitle>
            {t('auto.components.settings.cloudApi.approve.title', 'Approve an app')}
          </DialogTitle>
          <DialogDescription>
            {t(
              'auto.components.settings.cloudApi.approve.description',
              'When Claude, Cursor or another MCP client opens the Orca Cloud approval page, paste a one-time code from here instead of an API key. That page shows which website the app will return to; check it before you paste.'
            )}
          </DialogDescription>
        </DialogHeader>

        {/* One announcement as the code nears expiry, not one per tick. */}
        <span className="sr-only" role="status">
          {approval && !expired && remaining < 60_000
            ? t(
                'auto.components.settings.cloudApi.approve.almost',
                'The code expires in under a minute.'
              )
            : ''}
        </span>
        {approval ? (
          <div className="grid gap-3">
            <OneTimeSecret
              label={t('auto.components.settings.cloudApi.approve.codeLabel', 'Approval code')}
              value={approval.code}
              expired={expired}
              copyLabel={t('auto.components.settings.cloudApi.approve.copy', 'Copy approval code')}
              warningTitle={t(
                'auto.components.settings.cloudApi.approve.onceTitle',
                'Works once, for 10 minutes.'
              )}
              warningBody={t(
                'auto.components.settings.cloudApi.approve.onceBody',
                'Paste it on the approval page now. Orca will not show it again.'
              )}
              onCopied={() => setCopied(true)}
              footnote={
                expired ? (
                  <span role="status" className="flex items-center gap-1.5 text-destructive">
                    <TimerOff className="size-3.5" aria-hidden />
                    {t(
                      'auto.components.settings.cloudApi.approve.expired',
                      'This code expired. Generate a new one.'
                    )}
                  </span>
                ) : (
                  <span
                    className={cn(
                      'flex items-center gap-1.5 tabular-nums',
                      remaining < 60_000 && 'text-status-warning-text'
                    )}
                  >
                    <Timer className="size-3.5" aria-hidden />
                    {t(
                      'auto.components.settings.cloudApi.approve.expiresIn',
                      'Expires in {{value0}}',
                      {
                        value0: formatCountdown(remaining)
                      }
                    )}
                  </span>
                )
              }
            />
            <div className="flex flex-wrap items-center gap-1">
              <span className="mr-1 text-xs text-muted-foreground">
                {t('auto.components.settings.cloudApi.approve.grants', 'The app may use')}
              </span>
              <ScopeSummary scopes={approval.scopes} />
            </div>
          </div>
        ) : (
          <div className="grid gap-2">
            <p id={`${ids}-access`} className="text-xs font-medium">
              {t('auto.components.settings.cloudApi.approve.access', 'The app may')}
            </p>
            <SettingsSegmentedControl<'read' | 'full'>
              size="sm"
              equalWidth
              value={access}
              onChange={setAccess}
              ariaLabelledBy={`${ids}-access`}
              options={[
                {
                  value: 'read',
                  label: t('auto.components.settings.cloudApi.create.readOnly', 'Read only')
                },
                {
                  value: 'full',
                  label: t('auto.components.settings.cloudApi.create.full', 'Full access')
                }
              ]}
            />
            <p className="text-xs text-muted-foreground">
              {access === 'read'
                ? t(
                    'auto.components.settings.cloudApi.approve.readHint',
                    'List workspaces, projects and routines. It cannot start, change or delete anything.'
                  )
                : t(
                    'auto.components.settings.cloudApi.approve.fullHint',
                    'Start, sleep, wake and delete workspaces, message agents and manage routines as you.'
                  )}
            </p>
          </div>
        )}

        {error ? <CloudApiErrorNotice message={error} /> : null}

        <DialogFooter>
          {approval && !expired ? (
            <OneTimeSecretDoneButton
              copied={copied}
              onDone={() => change(false)}
              uncopiedLabel={t('auto.components.settings.cloudApi.approve.close', 'Close')}
            />
          ) : (
            <>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => change(false)}
                aria-disabled={busy}
              >
                {t('auto.components.settings.cloudApi.cancel', 'Cancel')}
              </Button>
              <Button
                type="button"
                size="sm"
                onClick={busy ? undefined : () => void generate()}
                aria-disabled={busy}
                aria-busy={busy}
              >
                {busy ? <Loader2 className="animate-spin motion-reduce:animate-none" /> : null}
                {expired
                  ? t('auto.components.settings.cloudApi.approve.regenerate', 'Generate a new code')
                  : t('auto.components.settings.cloudApi.approve.generate', 'Generate code')}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
