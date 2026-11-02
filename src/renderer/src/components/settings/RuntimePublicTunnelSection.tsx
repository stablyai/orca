import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Check,
  Copy,
  Globe2,
  Loader2,
  Power,
  RefreshCw,
  ShieldAlert,
  TriangleAlert
} from 'lucide-react'
import {
  idlePublicTunnelState,
  type PublicTunnelState
} from '../../../../shared/public-tunnel-types'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Label } from '../ui/label'

type CopyTarget = 'remote' | 'pairing'

function statusLabel(state: PublicTunnelState): string {
  switch (state.status) {
    case 'starting':
      return 'Starting Cloudflare Tunnel…'
    case 'connected':
      return 'Public link is live'
    case 'stopping':
      return 'Stopping tunnel…'
    case 'error':
      return 'Tunnel unavailable'
    default:
      return 'Public link is off'
  }
}

export function RuntimePublicTunnelSection(): React.JSX.Element {
  const [state, setState] = useState<PublicTunnelState>(idlePublicTunnelState)
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState<CopyTarget | null>(null)
  const [ipcError, setIpcError] = useState<string | null>(null)
  const copiedResetTimerRef = useRef<number | null>(null)

  useEffect(() => {
    let active = true
    const unsubscribe = window.api.mobile.onPublicTunnelStatusChanged((next) => {
      if (active) {
        setState(next)
        setBusy(next.status === 'starting' || next.status === 'stopping')
      }
    })
    void window.api.mobile
      .getPublicTunnelStatus()
      .then((next) => {
        if (active) {
          setState(next)
        }
      })
      .catch((error: unknown) => {
        if (active) {
          setIpcError(error instanceof Error ? error.message : String(error))
        }
      })
    return () => {
      active = false
      unsubscribe()
      if (copiedResetTimerRef.current !== null) {
        window.clearTimeout(copiedResetTimerRef.current)
        copiedResetTimerRef.current = null
      }
    }
  }, [])

  const startTunnel = useCallback(async (rotate: boolean): Promise<void> => {
    setBusy(true)
    setIpcError(null)
    try {
      const next = await window.api.mobile.startPublicTunnel({ rotate })
      setState(next)
    } catch (error) {
      setIpcError(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }, [])

  const stopTunnel = useCallback(async (): Promise<void> => {
    setBusy(true)
    setIpcError(null)
    try {
      const next = await window.api.mobile.stopPublicTunnel()
      setState(next)
    } catch (error) {
      setIpcError(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }, [])

  const copyValue = useCallback(async (target: CopyTarget, value: string): Promise<void> => {
    try {
      await window.api.ui.writeClipboardText(value)
      setCopied(target)
      if (copiedResetTimerRef.current !== null) {
        window.clearTimeout(copiedResetTimerRef.current)
      }
      copiedResetTimerRef.current = window.setTimeout(() => {
        copiedResetTimerRef.current = null
        setCopied(null)
      }, 1400)
    } catch (error) {
      setIpcError(error instanceof Error ? error.message : String(error))
    }
  }, [])

  const connected = state.status === 'connected' && state.remoteUrl !== null
  const canStart = state.status === 'idle' || state.status === 'error'

  return (
    <div className="space-y-3 rounded-lg border border-border/50 bg-muted/25 p-3">
      <div className="flex items-start gap-2">
        <div className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md border border-border bg-background">
          <Globe2 size={15} aria-hidden />
        </div>
        <div className="min-w-0 flex-1">
          <Label>Public internet access (Cloudflare Tunnel)</Label>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            Open this Orca server from a phone browser anywhere. The outbound tunnel needs no
            router change; the QR link carries a revocable runtime credential in its URL fragment.
          </p>
        </div>
      </div>

      <div className="flex items-center gap-2 text-xs">
        <span
          className={
            state.status === 'connected'
              ? 'size-2 rounded-full bg-emerald-500'
              : state.status === 'error'
                ? 'size-2 rounded-full bg-destructive'
                : state.status === 'starting' || state.status === 'stopping'
                  ? 'size-2 rounded-full bg-amber-500 animate-pulse'
                  : 'size-2 rounded-full bg-muted-foreground/50'
          }
          aria-hidden
        />
        <span className="font-medium">{statusLabel(state)}</span>
      </div>

      {state.error || ipcError ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs leading-5 text-destructive">
          <div className="flex items-start gap-1.5 font-medium">
            <TriangleAlert size={13} className="mt-0.5 shrink-0" aria-hidden />
            <span>{ipcError ?? state.error?.message}</span>
          </div>
          {state.error?.guidance ? (
            <p className="mt-1 text-destructive/90">{state.error.guidance}</p>
          ) : null}
        </div>
      ) : null}

      {connected ? (
        <div className="space-y-3">
          <div className="flex flex-col gap-3 sm:flex-row">
            {state.qrDataUrl ? (
              <div className="shrink-0 self-center rounded-md border border-border bg-white p-2">
                <img
                  src={state.qrDataUrl}
                  width={state.qrSize ?? 168}
                  height={state.qrSize ?? 168}
                  alt="Scan to open the mobile remote shell"
                  className="size-[168px]"
                />
              </div>
            ) : null}
            <div className="min-w-0 flex-1 space-y-2">
              <div className="space-y-1">
                <Label htmlFor="runtime-public-tunnel-url" className="text-xs">
                  Mobile link
                </Label>
                <div className="flex gap-1.5">
                  <Input
                    id="runtime-public-tunnel-url"
                    readOnly
                    value={state.remoteUrl ?? ''}
                    className="min-w-0 font-mono text-[11px]"
                    onFocus={(event) => event.currentTarget.select()}
                  />
                  <Button
                    type="button"
                    size="icon-sm"
                    variant="outline"
                    title="Copy mobile link"
                    aria-label="Copy mobile link"
                    onClick={() => void copyValue('remote', state.remoteUrl ?? '')}
                  >
                    {copied === 'remote' ? <Check size={13} /> : <Copy size={13} />}
                  </Button>
                </div>
              </div>
              {state.pairingUrl ? (
                <div className="space-y-1">
                  <Label htmlFor="runtime-public-tunnel-pairing" className="text-xs">
                    Pairing code
                  </Label>
                  <div className="flex gap-1.5">
                    <Input
                      id="runtime-public-tunnel-pairing"
                      readOnly
                      value={state.pairingUrl}
                      className="min-w-0 font-mono text-[11px]"
                      onFocus={(event) => event.currentTarget.select()}
                    />
                    <Button
                      type="button"
                      size="icon-sm"
                      variant="outline"
                      title="Copy pairing code"
                      aria-label="Copy pairing code"
                      onClick={() => void copyValue('pairing', state.pairingUrl ?? '')}
                    >
                      {copied === 'pairing' ? <Check size={13} /> : <Copy size={13} />}
                    </Button>
                  </div>
                </div>
              ) : null}
            </div>
          </div>

          <div className="flex items-start gap-1.5 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] leading-4 text-amber-700 dark:text-amber-400">
            <ShieldAlert size={13} className="mt-0.5 shrink-0" aria-hidden />
            <span>
              Anyone with this link can control agents on this computer. Stop the tunnel or revoke
              the grant when you are done.
            </span>
          </div>

          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => void startTunnel(true)}
              className="gap-1.5"
            >
              <RefreshCw size={13} aria-hidden />
              New link
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => void stopTunnel()}
              className="gap-1.5"
            >
              <Power size={13} aria-hidden />
              Stop tunnel
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          {canStart ? (
            <Button
              type="button"
              size="sm"
              disabled={busy}
              onClick={() => void startTunnel(false)}
              className="gap-1.5"
            >
              {busy ? (
                <Loader2 size={13} className="animate-spin" aria-hidden />
              ) : (
                <Globe2 size={13} aria-hidden />
              )}
              Start public tunnel
            </Button>
          ) : null}
          {state.status === 'starting' || state.status === 'stopping' ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy && state.status === 'stopping'}
              onClick={() => void stopTunnel()}
              className="gap-1.5"
            >
              {state.status === 'starting' ? (
                <Loader2 size={13} className="animate-spin" aria-hidden />
              ) : (
                <Power size={13} aria-hidden />
              )}
              {state.status === 'starting' ? 'Cancel' : 'Stopping…'}
            </Button>
          ) : null}
        </div>
      )}
    </div>
  )
}
