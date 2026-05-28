import { useMemo, useState } from 'react'
import { Cable, Loader2, Server, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  clearStoredWebRuntimeEnvironment,
  createStoredWebRuntimeEnvironment,
  isMixedContentWebSocket,
  readStoredWebRuntimeEnvironment,
  saveStoredWebRuntimeEnvironment
} from './web-runtime-environment'
import { parseWebPairingInput } from './web-pairing'
import { WebRuntimeClient } from './web-runtime-client'

type WebConnectProps = {
  initialPairingInput: string | null
  onConnected: () => void
}

export default function WebConnect({
  initialPairingInput,
  onConnected
}: WebConnectProps): React.JSX.Element {
  const existingEnvironment = readStoredWebRuntimeEnvironment()
  const [name, setName] = useState(existingEnvironment?.name ?? 'Orca Server')
  const [pairingCode, setPairingCode] = useState(initialPairingInput ?? '')
  const [error, setError] = useState<string | null>(null)
  const [connecting, setConnecting] = useState(false)
  const parsedOffer = useMemo(() => parseWebPairingInput(pairingCode), [pairingCode])

  const connect = async (): Promise<void> => {
    setError(null)
    if (!parsedOffer) {
      setError('Enter a valid Orca pairing URL or pairing code.')
      return
    }
    if (isMixedContentWebSocket(parsedOffer.endpoint)) {
      setError(
        'This HTTPS page cannot connect to a plain ws:// Orca server. Open the web client over HTTP or pair with a wss:// endpoint.'
      )
      return
    }
    setConnecting(true)
    const environment = createStoredWebRuntimeEnvironment({ name, offer: parsedOffer })
    const client = new WebRuntimeClient(parsedOffer)
    try {
      const response = await client.call('status.get', undefined, { timeoutMs: 15_000 })
      if (!response.ok) {
        throw new Error(response.error.message)
      }
      saveStoredWebRuntimeEnvironment({
        ...environment,
        runtimeId: response._meta.runtimeId,
        lastUsedAt: Date.now()
      })
      onConnected()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      client.close()
      setConnecting(false)
    }
  }

  const clear = (): void => {
    clearStoredWebRuntimeEnvironment()
    setPairingCode('')
    setError(null)
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4 py-6 text-foreground">
      <div className="flex w-full max-w-[520px] flex-col gap-5 rounded-lg border border-border bg-card p-5 shadow-sm">
        <div className="flex items-start gap-3">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-md border border-border bg-muted">
            <Server size={18} aria-hidden />
          </div>
          <div className="min-w-0">
            <h1 className="text-base font-semibold leading-6">Connect to Orca</h1>
            <p className="mt-1 text-sm leading-5 text-muted-foreground">
              Paste a pairing URL from an Orca server that this browser can reach.
            </p>
          </div>
        </div>

        <div className="grid gap-2">
          <Label htmlFor="web-runtime-name">Server name</Label>
          <Input
            id="web-runtime-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            autoComplete="off"
          />
        </div>

        <div className="grid gap-2">
          <Label htmlFor="web-runtime-pairing-code">Pairing URL or code</Label>
          <Input
            id="web-runtime-pairing-code"
            value={pairingCode}
            onChange={(event) => setPairingCode(event.target.value)}
            placeholder="orca://pair#..."
            autoComplete="off"
            spellCheck={false}
          />
        </div>

        {parsedOffer && (
          <div className="rounded-md border border-border bg-muted px-3 py-2 text-xs text-muted-foreground">
            Endpoint: {parsedOffer.endpoint}
          </div>
        )}

        {error && (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </div>
        )}

        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-between">
          <Button type="button" variant="outline" onClick={clear} className="gap-2">
            <Trash2 size={15} aria-hidden />
            Clear saved server
          </Button>
          <Button
            type="button"
            onClick={() => void connect()}
            disabled={connecting || !parsedOffer}
            className="gap-2"
          >
            {connecting ? (
              <Loader2 size={15} className="animate-spin" aria-hidden />
            ) : (
              <Cable size={15} aria-hidden />
            )}
            Connect
          </Button>
        </div>
      </div>
    </div>
  )
}
