import { useRef, useState } from 'react'
import type { PublicKnownRuntimeEnvironment } from '../../../../shared/runtime-environments'
import type { OrcadOutgoingRecoveryCandidate } from '../../../../shared/orcad-outgoing-recovery'
import { translate } from '@/i18n/i18n'
import { isWebClientLocation } from '@/lib/web-client-location'
import { Button } from '../ui/button'
import { Label } from '../ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'

export function OrcadCaptureRecoverySection({
  environments
}: {
  environments: PublicKnownRuntimeEnvironment[]
}): React.JSX.Element | null {
  const [selector, setSelector] = useState('')
  const [candidates, setCandidates] = useState<OrcadOutgoingRecoveryCandidate[] | null>(null)
  const [selected, setSelected] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const pending = useRef(false)
  const environment = environments.find((entry) => entry.id === selector)
  const candidate = candidates?.find((entry) => entry.bridgeId === selected)
  const matchesRuntime = candidate && candidate.destinationRuntimeId === environment?.runtimeId
  if (isWebClientLocation()) {
    return null
  }

  const perform = async (operation: () => Promise<void>) => {
    if (pending.current) {
      return
    }
    pending.current = true
    setBusy(true)
    setError('')
    setMessage('')
    try {
      await operation()
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      pending.current = false
      setBusy(false)
    }
  }
  return (
    <section
      className="space-y-3 border-t pt-4"
      aria-label={translate('orcadCaptureRecovery.title', 'Terminal transfer recovery')}
    >
      <div className="space-y-1">
        <h3 className="text-sm font-medium">
          {translate('orcadCaptureRecovery.title', 'Terminal transfer recovery')}
        </h3>
        <p className="text-xs text-muted-foreground">
          {translate(
            'orcadCaptureRecovery.description',
            'Retry a saved terminal transfer to its original server. This does not start a new migration or complete host cutover. Recovery requires the experimental migration gate.'
          )}
        </p>
      </div>
      <Label htmlFor="orcad-recovery-server">
        {translate('orcadCaptureRecovery.server', 'Destination server')}
      </Label>
      <Select
        value={selector}
        disabled={busy}
        onValueChange={(value) => {
          setSelector(value)
          setCandidates(null)
          setSelected('')
          setError('')
          setMessage('')
        }}
      >
        <SelectTrigger id="orcad-recovery-server">
          <SelectValue
            placeholder={translate('orcadCaptureRecovery.chooseServer', 'Choose a server')}
          />
        </SelectTrigger>
        <SelectContent>
          {environments.map((entry) => (
            <SelectItem key={entry.id} value={entry.id}>
              {entry.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Button
        variant="outline"
        size="sm"
        disabled={busy || !environment}
        onClick={() =>
          void perform(async () => {
            setCandidates(null)
            setSelected('')
            setCandidates(
              await window.api.runtimeEnvironments.listOrcadOutgoingCaptures({
                selector,
                includePreparations: true
              })
            )
          })
        }
      >
        {translate('orcadCaptureRecovery.load', 'Load saved transfers')}
      </Button>
      {candidates?.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          {translate(
            'orcadCaptureRecovery.emptyTransfers',
            'No saved terminal transfers for this server.'
          )}
        </p>
      ) : null}
      {candidates && candidates.length > 0 ? (
        <>
          <Label htmlFor="orcad-recovery-capture">
            {translate('orcadCaptureRecovery.capture', 'Saved transfer')}
          </Label>
          <Select
            value={selected}
            disabled={busy}
            onValueChange={(value) => {
              setSelected(value)
              setError('')
              setMessage('')
            }}
          >
            <SelectTrigger id="orcad-recovery-capture">
              <SelectValue
                placeholder={translate('orcadCaptureRecovery.chooseCapture', 'Choose one transfer')}
              />
            </SelectTrigger>
            <SelectContent>
              {candidates.map((entry) => (
                <SelectItem key={entry.bridgeId} value={entry.bridgeId}>
                  {entry.terminalId} · {entry.bridgeId}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {candidate ? (
            <p className="break-all font-mono text-xs text-muted-foreground">
              {candidate.sourceSshTargetId} · {candidate.incarnationId}
            </p>
          ) : null}
          {candidate?.stage === 'preparation' ? (
            <p className="text-xs text-muted-foreground">
              {translate(
                'orcadCaptureRecovery.preparation',
                'Saved preparation: retry continues source preparation, captures the terminal model, and publishes it to the original destination. The original SSH source must be connected.'
              )}
            </p>
          ) : null}
          {candidate && !matchesRuntime ? (
            <p role="alert" className="text-xs text-destructive">
              {translate(
                'orcadCaptureRecovery.changed',
                'This server no longer matches the saved destination runtime. Recovery is blocked.'
              )}
            </p>
          ) : null}
          <p className="text-xs text-muted-foreground">
            {translate(
              'orcadCaptureRecovery.evidenceWarning',
              'Saved evidence is not proof of source selection or publication. If a request fails or times out, keep the saved transfer and retry; the destination may already have accepted it.'
            )}
          </p>
          <Button
            size="sm"
            disabled={busy || !matchesRuntime}
            onClick={() =>
              void perform(async () => {
                if (!candidate) {
                  return
                }
                await window.api.runtimeEnvironments.recoverOrcadOutgoingCapture({
                  selector,
                  bridgeId: candidate.bridgeId,
                  ...(candidate.stage === 'preparation' ? { stage: 'preparation' as const } : {})
                })
                setMessage(
                  translate(
                    'orcadCaptureRecovery.published',
                    'Destination publication confirmed. Host cutover and source retirement are separate steps.'
                  )
                )
              })
            }
          >
            {translate('orcadCaptureRecovery.retry', 'Retry selected transfer')}
          </Button>
        </>
      ) : null}
      {busy ? (
        <p role="status" className="text-xs text-muted-foreground">
          {translate('orcadCaptureRecovery.working', 'Checking saved transfer…')}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="break-words text-xs text-destructive">
          {error}
        </p>
      ) : null}
      {message ? (
        <p role="status" className="text-xs text-muted-foreground">
          {message}
        </p>
      ) : null}
    </section>
  )
}
