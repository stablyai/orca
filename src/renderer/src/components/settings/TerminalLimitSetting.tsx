import { useEffect, useMemo, useRef, useState } from 'react'
import {
  terminalLimitInputMaximum,
  type TerminalLimitStatus
} from '../../../../shared/terminal-limit-policy'
import { Input } from '../ui/input'
import { Button } from '../ui/button'
import { SettingsRow } from './SettingsFormControls'
import { SearchableSetting } from './SearchableSetting'
import type { SettingsHostScope } from './settings-host-scope'
import { readTerminalLimit, saveTerminalLimit } from './terminal-limit-transport'
import { useAppStore } from '@/store'
import { getRuntimeEnvironmentConnectionGeneration } from '@/store/slices/runtime-status-connection-generation'
import {
  captureHostIdentityFence,
  isHostIdentityFenceCurrent,
  type HostIdentityFence
} from '@/store/host-catalog-fencing'
import type { HostRoute } from '@/runtime/runtime-client-target'
import { getIntlLocale, translate } from '@/i18n/i18n'
import { runtimeHostContactForEntry } from '../../../../shared/runtime-host-contact'
import { getTerminalLimitSearchKeywords } from './terminal-advanced-platform-search'

export function TerminalLimitSetting({ scope }: { scope: SettingsHostScope }): React.JSX.Element {
  const environmentId = scope.target.kind === 'environment' ? scope.target.environmentId : null
  const revision = useAppStore((state) => {
    const host = state.runtimeEnvironments.find((item) => item.id === environmentId)
    const pairing = host?.pairingRevision ?? host?.createdAt ?? 0
    const connection = environmentId ? getRuntimeEnvironmentConnectionGeneration(environmentId) : 0
    const contactEpoch =
      state.runtimeStatusByEnvironmentId.get(environmentId ?? '')?.hostContactEpoch ?? 0
    return `${pairing}:${connection}:${contactEpoch}`
  })
  const contacted = useAppStore(
    (state) =>
      environmentId === null ||
      runtimeHostContactForEntry(state.runtimeStatusByEnvironmentId.get(environmentId)).verdict ===
        'live'
  )
  const available = scope.available && contacted
  return (
    <TerminalLimitField
      key={`${environmentId ?? 'local'}:${revision}:${available}`}
      scope={{ ...scope, available }}
    />
  )
}

function TerminalLimitField({ scope }: { scope: SettingsHostScope }): React.JSX.Element {
  const route = useMemo<HostRoute>(() => ({ target: scope.target, at: 'local' }), [scope.target])
  const [status, setStatus] = useState<TerminalLimitStatus | null>()
  const [draft, setDraft] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  const [busy, setBusy] = useState(false)
  const controller = useRef<AbortController | null>(null)
  const confirmedFence = useRef<HostIdentityFence | null>(null)
  const saving = useRef(false)
  const saveGeneration = useRef(0)
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    const request = new AbortController()
    controller.current = request
    const fence = captureHostIdentityFence(route)
    setStatus(undefined)
    setFailed(false)
    if (scope.available) {
      void readTerminalLimit(route, request.signal)
        .then((value) => {
          if (!request.signal.aborted && isHostIdentityFenceCurrent(fence)) {
            confirmedFence.current = fence
            setStatus(value)
          }
        })
        .catch(() => {
          if (!request.signal.aborted) {
            setFailed(true)
          }
        })
    }
    return () => request.abort()
  }, [route, scope.available, retry])

  const maximum = terminalLimitInputMaximum(status?.systemPtyLimit ?? null)
  const commit = async (): Promise<void> => {
    const request = controller.current
    if (
      !status?.editable ||
      draft === null ||
      saving.current ||
      !request ||
      request.signal.aborted
    ) {
      return
    }
    if (!confirmedFence.current || !isHostIdentityFenceCurrent(confirmedFence.current)) {
      setFailed(true)
      return
    }
    if (draft === '' || !Number.isFinite(Number(draft))) {
      setDraft(null)
      return
    }
    const value = Math.max(1, Math.min(maximum, Math.trunc(Number(draft))))
    if (value === status.maxTerminals && !status.savedUnreadable) {
      setDraft(null)
      return
    }
    saving.current = true
    const generation = ++saveGeneration.current
    setBusy(true)
    setFailed(false)
    try {
      const confirmed = await saveTerminalLimit(
        route,
        { maxTerminals: value, daemonNonce: status.daemonNonce },
        request.signal
      )
      if (!request.signal.aborted) {
        if (!confirmed) {
          throw new Error('Unsupported terminal service')
        }
        setStatus(confirmed)
        setDraft(null)
      }
    } catch {
      if (!request.signal.aborted) {
        setFailed(true)
        // Refresh a changed host bound, while retaining the user's draft for retry.
        void readTerminalLimit(route, request.signal)
          .then((fresh) => {
            if (!request.signal.aborted && saveGeneration.current === generation) {
              setStatus(fresh)
            }
          })
          .catch(() => undefined)
      }
    } finally {
      saving.current = false
      if (!request.signal.aborted) {
        setBusy(false)
      }
    }
  }

  const unavailable = !scope.available
    ? translate(
        'settings.terminal.limit.disconnected',
        'This host is disconnected. Reconnect to view or change its terminal limit.'
      )
    : status === null
      ? translate(
          'settings.terminal.limit.unsupported',
          'This host’s terminal service does not support changing this limit yet.'
        )
      : status?.editable === false && status.source !== 'environment'
        ? translate('settings.terminal.limit.unknown', 'Unavailable')
        : status?.source === 'environment'
          ? translate(
              'settings.terminal.limit.environment',
              'This Orca instance has a terminal limit set by its environment. Remove the override on this host to edit it here.'
            )
          : null
  const label = translate('settings.terminal.limit.label', 'Maximum running terminals')
  return (
    <SearchableSetting
      title={label}
      description={translate(
        'settings.terminal.limit.description',
        'Limits your running terminals across projects on this host.'
      )}
      keywords={getTerminalLimitSearchKeywords()}
    >
      <SettingsRow
        alignTop
        label={label}
        labelId="terminal-running-limit-label"
        description={
          <>
            <span className="block">
              {translate(
                'settings.terminal.limit.description',
                'Limits your running terminals across projects on this host.'
              )}
            </span>
            <span className="mt-2 block">
              {translate('settings.terminal.limit.system', 'System PTY limit: {{value}}', {
                value:
                  status === undefined && scope.available && !failed
                    ? '…'
                    : (status?.systemPtyLimit?.toLocaleString(getIntlLocale()) ??
                      translate('settings.terminal.limit.unknown', 'Unavailable'))
              })}
            </span>
            <span className="block">
              {translate(
                'settings.terminal.limit.shared',
                'Shared with other terminal apps. This is total capacity, not free slots.'
              )}
            </span>
            {unavailable ? <span className="mt-2 block">{unavailable}</span> : null}
            {status?.savedUnreadable && !failed ? (
              <span className="mt-2 block" role="status">
                {translate(
                  'settings.terminal.limit.savedUnreadable',
                  'Couldn’t read this host’s saved terminal limit. Using {{value}}. Enter a value and press Enter to replace it.',
                  { value: status.maxTerminals.toLocaleString(getIntlLocale()) }
                )}
              </span>
            ) : null}
            {failed ? (
              <span className="mt-2 block text-destructive" role="status">
                {translate(
                  'settings.terminal.limit.failed',
                  'Couldn’t confirm the terminal limit. Try again.'
                )}
              </span>
            ) : null}
            {failed && status === undefined ? (
              <Button
                type="button"
                variant="ghost"
                size="xs"
                onClick={() => setRetry((value) => value + 1)}
              >
                {translate('settings.terminal.limit.retry', 'Retry')}
              </Button>
            ) : null}
          </>
        }
        control={
          <div className="flex items-center gap-2">
            <Input
              id="terminal-running-limit"
              aria-labelledby="terminal-running-limit-label"
              type="number"
              inputMode="numeric"
              min={1}
              max={maximum}
              step={1}
              disabled={!scope.available || !status?.editable || busy}
              placeholder={status === undefined && !failed ? '…' : '—'}
              value={draft ?? (status ? String(status.maxTerminals) : '')}
              onChange={(event) => {
                const raw = event.target.value
                setDraft(
                  raw === '' ? '' : String(Math.max(1, Math.min(maximum, Math.trunc(Number(raw)))))
                )
                setFailed(false)
              }}
              onBlur={() => void commit()}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  void commit()
                }
                if (event.key === 'Escape') {
                  setDraft(null)
                  setFailed(false)
                }
              }}
              className="number-input-clean w-24 tabular-nums"
            />
            <span className="text-xs text-muted-foreground">
              {translate('settings.terminal.limit.unit', 'terminals')}
            </span>
          </div>
        }
      />
    </SearchableSetting>
  )
}
