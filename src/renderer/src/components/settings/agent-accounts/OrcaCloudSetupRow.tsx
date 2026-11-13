// S0 state 6: the setup running on this computer (browser, broker, device code, paste, saving).
import type React from 'react'
import { useId, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import { Button } from '@/components/ui/button'
import type { OrcaCloudAccountRow } from '@/lib/orca-cloud/orca-cloud-agent-accounts-model'
import type {
  OrcaCloudAccountAgent,
  OrcaCloudAgentsErrorCode
} from '../../../../../shared/orca-cloud-agents/orca-cloud-agents-wire'
import { SecretValueInput } from '../cloud-secrets/SecretValueInput'
import { ElapsedSuffix, RowShell } from './orca-cloud-account-row-shell'
import { setupFailureCopy } from './orca-cloud-accounts-copy'
import { CloudStripPasteForm } from '@/components/agent-sign-in-strip/CloudStripPasteForm'
import { setupCodePaste } from '@/components/agent-sign-in-strip/cloud-agent-setup-strip-model'
import type { OrcaCloudAccountsActions } from './orca-cloud-accounts-types'
import { OpenExternalSplitButton } from '@/components/open-external/OpenExternalSplitButton'
import { requireLink } from '@/components/open-external/copy-external-link'

/** The provider page "Open again" reopens, minted by main the same way but not opened. */
async function setupSignInLink(agent: OrcaCloudAccountAgent): Promise<string> {
  const api = window.api.orcaCloudAgents
  return requireLink(api ? await api.signInLink({ agent }) : null)
}

function PasteTokenForm({
  reason,
  onPaste,
  onCancel
}: {
  reason: 'capture_failed' | 'no_cli' | 'chosen'
  onPaste: (token: string) => Promise<OrcaCloudAgentsErrorCode | null>
  onCancel: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const id = useId()
  const [value, setValue] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<OrcaCloudAgentsErrorCode | null>(null)
  const helpId = `${id}-help`
  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault()
    if (saving || !value.trim()) {
      return
    }
    setSaving(true)
    let result: OrcaCloudAgentsErrorCode | null = 'unknown'
    try {
      result = await onPaste(value)
    } finally {
      setSaving(false)
      // Cleared whatever happens: a value that wasn't stored isn't kept around in the renderer.
      setValue('')
      setError(result)
    }
  }
  return (
    <form className="space-y-1.5" onSubmit={(event) => void submit(event)}>
      <label htmlFor={id} className="sr-only">
        {t('orcaCloudAccounts.paste.label', 'Claude setup token')}
      </label>
      <div className="flex items-center gap-1.5">
        <div className="min-w-0 flex-1">
          <SecretValueInput
            id={id}
            value={value}
            onChange={(next) => {
              setValue(next)
              setError(null)
            }}
            placeholder={t('orcaCloudAccounts.paste.placeholder', 'sk-ant-oat01-…')}
            invalid={error !== null}
            autoFocus={reason === 'chosen'}
            disabled={saving}
            describedBy={helpId}
          />
        </div>
        <Button
          type="submit"
          variant="outline"
          size="sm"
          disabled={saving || !value.trim()}
          aria-busy={saving || undefined}
        >
          {saving ? <Loader2 aria-hidden className="motion-safe:animate-spin" /> : null}
          {t('orcaCloudAccounts.paste.save', 'Save')}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={saving}>
          {t('orcaCloudAccounts.cancel', 'Cancel')}
        </Button>
      </div>
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {setupFailureCopy('claude', error, t).title}
        </p>
      ) : (
        <p id={helpId} className="text-xs text-muted-foreground">
          {t('orcaCloudAccounts.paste.help', 'Write-only. You won’t see it again after saving.')}
        </p>
      )}
    </form>
  )
}

function pasteReasonCopy(reason: 'capture_failed' | 'no_cli' | 'chosen', t: Translate): string {
  switch (reason) {
    case 'capture_failed':
      return t(
        'orcaCloudAccounts.paste.captureFailed',
        'Orca couldn’t read the token from claude setup-token. Run it in a terminal, then paste the token it prints.'
      )
    case 'no_cli':
      return t(
        'orcaCloudAccounts.paste.noCli',
        'The claude command isn’t on this computer. Run claude setup-token anywhere, then paste the token.'
      )
    case 'chosen':
      return t(
        'orcaCloudAccounts.paste.chosen',
        'Run claude setup-token anywhere, then paste the token it prints.'
      )
  }
}

function deviceHost(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}

export function SetupRow({
  agent,
  row,
  actions,
  now
}: {
  agent: OrcaCloudAccountAgent
  row: Extract<OrcaCloudAccountRow, { kind: 'setup' }>
  actions: OrcaCloudAccountsActions
  now: number
}): React.JSX.Element {
  const t = useTranslate()
  const cancel = (
    <Button type="button" variant="ghost" size="sm" onClick={() => actions.cancel(agent)}>
      {t('orcaCloudAccounts.cancel', 'Cancel')}
    </Button>
  )
  const setup = row.setup
  switch (setup.phase) {
    case 'browser':
      return (
        <RowShell
          agent={agent}
          tone="busy"
          title={
            <>
              {t('orcaCloudAccounts.settingUp', 'Finish in your browser')}
              <ElapsedSuffix startedAt={setup.startedAt} now={now} />
            </>
          }
          detail={
            setup.code === 'rejected'
              ? t(
                  'agentSignInStrip.setupCodeRejected',
                  'That code didn’t work. Paste the newest code from the sign-in page, or open it again.'
                )
              : setup.acceptsCode
                ? t(
                    'agentSignInStrip.finishInBrowserPaste',
                    'Finish in your browser, then paste the code here.'
                  )
                : t(
                    'orcaCloudAccounts.settingUpClaudeDetail',
                    'Orca runs claude setup-token on this computer, then saves the result to your Orca account.'
                  )
          }
          detailTone={setup.code === 'rejected' ? 'warning' : undefined}
          actions={
            <>
              {setup.canReopen ? (
                <OpenExternalSplitButton
                  link={() => setupSignInLink(agent)}
                  variant="ghost"
                  size="sm"
                  onClick={() => actions.reopen(agent)}
                >
                  {t('orcaCloudAccounts.openAgain', 'Open again')}
                </OpenExternalSplitButton>
              ) : null}
              {cancel}
            </>
          }
        >
          {/* Line 2 (design-squad): [Paste code ………] [Finish setup], the field filling the column. */}
          {setup.acceptsCode || setup.code === 'rejected' ? (
            <CloudStripPasteForm
              fill
              paste={setupCodePaste(agent, setup.code, t, { waiting: !setup.acceptsCode })}
              onSubmitCode={() => undefined}
              onSubmitSetupCode={(code) => actions.submitSetupCode?.(code)}
            />
          ) : null}
        </RowShell>
      )
    case 'preparing':
      return (
        <RowShell
          agent={agent}
          tone="busy"
          title={
            <>
              {t('orcaCloudAccounts.preparing', 'Getting ChatGPT sign-in ready')}
              <ElapsedSuffix startedAt={setup.startedAt} now={now} />
            </>
          }
          detail={t(
            'orcaCloudAccounts.preparingDetail',
            'Codex signs in once in a short-lived sandbox. Orca then keeps the sign-in in your Orca account.'
          )}
          actions={cancel}
        />
      )
    case 'device':
      return (
        <RowShell
          agent={agent}
          tone="busy"
          title={
            <>
              {t('orcaCloudAccounts.deviceEnter', 'Enter')}{' '}
              <code className="select-all rounded bg-muted px-1.5 py-0.5 font-mono text-sm tracking-wider text-foreground">
                {setup.userCode}
              </code>{' '}
              {t('orcaCloudAccounts.deviceOn', 'on {{host}}', {
                host: deviceHost(setup.verificationUrl)
              })}
              <ElapsedSuffix startedAt={setup.startedAt} now={now} />
            </>
          }
          detail={t(
            'orcaCloudAccounts.deviceGuard',
            'Only continue if you started this sign-in in Orca.'
          )}
          actions={
            <>
              <OpenExternalSplitButton
                link={setup.verificationUrl}
                variant="outline"
                size="sm"
                onClick={() => {
                  actions.copyCode(setup.userCode)
                  actions.reopen(agent)
                }}
              >
                {t('orcaCloudAccounts.copyAndOpen', 'Copy code and open')}
              </OpenExternalSplitButton>
              {cancel}
            </>
          }
        />
      )
    case 'paste':
      return (
        <RowShell
          agent={agent}
          tone="none"
          title={t('orcaCloudAccounts.pasteInstead', 'Paste the token instead')}
          detail={pasteReasonCopy(setup.reason, t)}
        >
          <PasteTokenForm
            reason={setup.reason}
            onPaste={actions.pasteToken}
            onCancel={() => actions.cancel(agent)}
          />
        </RowShell>
      )
    case 'saving':
      return (
        <RowShell
          agent={agent}
          tone="busy"
          title={t('orcaCloudAccounts.saving', 'Saving to your Orca account…')}
        />
      )
  }
}
