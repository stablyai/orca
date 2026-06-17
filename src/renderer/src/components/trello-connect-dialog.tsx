import { useRef, useState } from 'react'
import { ExternalLink, LoaderCircle, Lock } from 'lucide-react'
import { useAppStore } from '@/store'
import { useMountedRef } from '@/hooks/useMountedRef'
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
import { Label } from '@/components/ui/label'
import { TrelloIcon } from '@/components/icons/TrelloIcon'

type TrelloConnectDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  onConnected?: () => void
}

export function TrelloConnectDialog({
  open,
  onOpenChange,
  onConnected
}: TrelloConnectDialogProps): React.JSX.Element {
  const connectTrello = useAppStore((s) => s.connectTrello)
  const testTrelloConnection = useAppStore((s) => s.testTrelloConnection)
  const mountedRef = useMountedRef()

  const [apiKey, setApiKey] = useState('')
  const [token, setToken] = useState('')
  const [phase, setPhase] = useState<'idle' | 'connecting' | 'testing'>('idle')
  const [error, setError] = useState<string | null>(null)
  const attemptIdRef = useRef(0)

  const resetState = (): void => {
    setApiKey('')
    setToken('')
    setPhase('idle')
    setError(null)
  }

  const handleOpenChange = (next: boolean): void => {
    if (!next && phase !== 'idle') {
      return
    }
    if (!next) {
      ++attemptIdRef.current
      resetState()
    }
    onOpenChange(next)
  }

  const handleAuthorize = (): void => {
    const trimmedApiKey = apiKey.trim()
    if (!trimmedApiKey) {
      setError('Enter the Power-Up API Key first.')
      return
    }
    setError(null)
    const params = new URLSearchParams({
      expiration: 'never',
      scope: 'read,write',
      response_type: 'token',
      name: 'Orca',
      key: trimmedApiKey
    })
    window.api.shell.openUrl(`https://trello.com/1/authorize?${params.toString()}`)
  }

  const isCurrentAttempt = (attemptId: number): boolean =>
    mountedRef.current && attemptId === attemptIdRef.current

  const handleConnect = async (): Promise<void> => {
    if (!apiKey.trim() || !token.trim()) {
      setError('API key and token are required.')
      return
    }
    const attemptId = ++attemptIdRef.current
    setPhase('connecting')
    setError(null)
    try {
      const result = await connectTrello({ apiKey: apiKey.trim(), token: token.trim() })
      if (!isCurrentAttempt(attemptId)) {
        return
      }
      if (!result.ok) {
        setPhase('idle')
        setError(result.error)
        return
      }
      setPhase('testing')
      const testResult = await testTrelloConnection()
      if (!isCurrentAttempt(attemptId)) {
        return
      }
      if (!testResult.ok) {
        setPhase('idle')
        setError(testResult.error)
        return
      }
      onConnected?.()
      handleOpenChange(false)
    } catch (err) {
      if (!isCurrentAttempt(attemptId)) {
        return
      }
      setPhase('idle')
      setError(err instanceof Error ? err.message : 'Connection failed.')
    }
  }
  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-[420px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <TrelloIcon className="size-4" />
            Connect to Trello
          </DialogTitle>
          <DialogDescription>
            Enter your Trello Power-Up API Key, authorize Orca in Trello, then paste the returned
            token.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="rounded-md border border-border/50 bg-muted/30 px-3 py-2.5">
            <p className="text-xs text-muted-foreground">
              Create or open a Trello Power-Up in the{' '}
              <button
                type="button"
                className="inline-flex items-center gap-1 text-foreground underline underline-offset-2"
                onClick={() => window.api.shell.openUrl('https://trello.com/power-ups/admin')}
              >
                Power-Up admin portal <ExternalLink className="size-3" />
              </button>
              . Copy the Power-Up API Key — not the Secret.
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="trello-api-key" className="text-xs font-medium">
              1. Power-Up API Key
            </Label>
            <Input
              id="trello-api-key"
              placeholder="Paste the API Key value, not the Secret"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              disabled={phase !== 'idle'}
              className="font-mono text-xs"
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleAuthorize}
              disabled={phase !== 'idle' || !apiKey.trim()}
            >
              <ExternalLink className="size-3.5 mr-1.5" />
              Authorize in Trello
            </Button>
          </div>

          <div className="space-y-2">
            <Label htmlFor="trello-token" className="text-xs font-medium">
              2. Token returned by Trello
            </Label>
            <div className="relative">
              <Input
                id="trello-token"
                type="password"
                placeholder="Paste the token shown after authorizing"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                disabled={phase !== 'idle'}
                className="pr-8 font-mono text-xs"
              />
              <Lock className="pointer-events-none absolute right-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground/50" />
            </div>
            <p className="text-[11px] text-muted-foreground/70">
              Trello does not require the Power-Up Secret for this token flow. The token is stored
              on disk.
            </p>
          </div>

          {error && (
            <p className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {error}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            size="sm"
            onClick={() => handleOpenChange(false)}
            disabled={phase !== 'idle'}
          >
            Cancel
          </Button>
          <Button size="sm" onClick={() => void handleConnect()} disabled={phase !== 'idle'}>
            {phase === 'idle' ? (
              'Connect'
            ) : phase === 'connecting' ? (
              <>
                <LoaderCircle className="size-3.5 mr-1.5 animate-spin" />
                Connecting…
              </>
            ) : (
              <>
                <LoaderCircle className="size-3.5 mr-1.5 animate-spin" />
                Verifying…
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
