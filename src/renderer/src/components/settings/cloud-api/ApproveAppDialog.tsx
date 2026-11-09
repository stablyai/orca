import { useEffect, useId, useState } from 'react'
import { Loader2, ShieldCheck, TimerOff } from 'lucide-react'
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
import { CloudApiErrorNotice, CopyValueButton, ScopeChip } from './cloud-api-parts'

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
  const [access, setAccess] = useState<'read' | 'full'>('full')
  const [approval, setApproval] = useState<CloudApiApproval | null>(initialApproval ?? null)
  const [busy, setBusy] = useState(false)
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
    if (!next) {
      // A code never outlives the dialog that showed it.
      setApproval(null)
      setError(null)
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
        onInteractOutside={approval ? (event) => event.preventDefault() : undefined}
      >
        <DialogHeader>
          <DialogTitle>
            {t('auto.components.settings.cloudApi.approve.title', 'Approve an app')}
          </DialogTitle>
          <DialogDescription>
            {t(
              'auto.components.settings.cloudApi.approve.description',
              'When Claude, Cursor or another MCP client opens the Orca Cloud approval page, paste a one-time code from here instead of an API key.'
            )}
          </DialogDescription>
        </DialogHeader>

        {approval ? (
          <div className="grid gap-3">
            <div className="flex items-center gap-2">
              <label htmlFor={`${ids}-code`} className="sr-only">
                {t('auto.components.settings.cloudApi.approve.codeLabel', 'Approval code')}
              </label>
              <Input
                id={`${ids}-code`}
                readOnly
                value={expired ? '' : approval.code}
                placeholder={t(
                  'auto.components.settings.cloudApi.approve.expiredPlaceholder',
                  'Code expired'
                )}
                disabled={expired}
                spellCheck={false}
                className="font-mono text-xs"
                onClick={(event) => event.currentTarget.select()}
              />
              {expired ? null : (
                <CopyValueButton
                  value={approval.code}
                  variant="default"
                  size="sm"
                  label={t('auto.components.settings.cloudApi.approve.copy', 'Copy approval code')}
                />
              )}
            </div>
            <p
              className={cn(
                'flex items-center gap-1.5 text-xs',
                expired ? 'text-destructive' : 'text-muted-foreground'
              )}
            >
              {expired ? (
                <TimerOff className="size-3.5" aria-hidden />
              ) : (
                <ShieldCheck className="size-3.5" aria-hidden />
              )}
              {expired
                ? t(
                    'auto.components.settings.cloudApi.approve.expired',
                    'This code expired. Generate a new one.'
                  )
                : t(
                    'auto.components.settings.cloudApi.approve.expires',
                    'Works once and expires in {{value0}}. Orca will not show it again.',
                    { value0: formatCountdown(remaining) }
                  )}
            </p>
            <div className="flex flex-wrap gap-1">
              {approval.scopes.map((scope) => (
                <ScopeChip key={scope} scope={scope} />
              ))}
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
                  label: t('auto.components.settings.cloudApi.approve.read', 'Look, not touch')
                },
                {
                  value: 'full',
                  label: t('auto.components.settings.cloudApi.approve.full', 'Do anything you can')
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
                    'Start and stop workspaces, message agents and manage routines as you.'
                  )}
            </p>
          </div>
        )}

        {error ? <CloudApiErrorNotice message={error} /> : null}

        <DialogFooter>
          {approval && !expired ? (
            <Button type="button" size="sm" onClick={() => change(false)}>
              {t('auto.components.settings.cloudApi.secret.done', 'Done')}
            </Button>
          ) : (
            <>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => change(false)}
                disabled={busy}
              >
                {t('auto.components.settings.cloudApi.cancel', 'Cancel')}
              </Button>
              <Button type="button" size="sm" onClick={() => void generate()} disabled={busy}>
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
