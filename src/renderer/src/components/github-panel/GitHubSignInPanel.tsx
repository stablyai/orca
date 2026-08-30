import { useCallback, useEffect, useRef, useState } from 'react'
import { Check, Copy, Github, Loader2 } from 'lucide-react'
import type { GitHubDeviceFlowStart } from '../../../../shared/github-account'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { translate } from '@/i18n/i18n'

type DeviceFlowState =
  | { phase: 'idle' }
  | { phase: 'starting' }
  | { phase: 'awaiting'; flow: GitHubDeviceFlowStart }
  | { phase: 'error'; error: string }

function DeviceFlowSection({
  onConnected
}: {
  onConnected: () => Promise<void>
}): React.JSX.Element {
  const [state, setState] = useState<DeviceFlowState>({ phase: 'idle' })
  const [copied, setCopied] = useState(false)
  // Why: generation guard so a cancelled/superseded flow stops its poll loop.
  const generationRef = useRef(0)

  const cancel = useCallback((): void => {
    generationRef.current += 1
    setState({ phase: 'idle' })
  }, [])

  useEffect(() => {
    return () => {
      generationRef.current += 1
    }
  }, [])

  const start = useCallback(async (): Promise<void> => {
    const generation = ++generationRef.current
    setState({ phase: 'starting' })
    const result = await window.api.githubAuth.startDeviceFlow()
    if (generation !== generationRef.current) {
      return
    }
    if (!result.ok) {
      setState({ phase: 'error', error: result.error })
      return
    }
    const flow = result.flow
    setState({ phase: 'awaiting', flow })
    void window.api.shell.openUrl(flow.verificationUri)

    let intervalSeconds = flow.pollIntervalSeconds
    const deadline = Date.now() + flow.expiresInSeconds * 1000
    while (generation === generationRef.current) {
      await new Promise((resolve) => setTimeout(resolve, intervalSeconds * 1000))
      if (generation !== generationRef.current) {
        return
      }
      if (Date.now() > deadline) {
        setState({
          phase: 'error',
          error: translate(
            'auto.components.github-panel.GitHubSignInPanel.codeExpired',
            'The sign-in code expired. Start over to get a new one.'
          )
        })
        return
      }
      const poll = await window.api.githubAuth.pollDeviceFlow({ deviceCode: flow.deviceCode })
      if (generation !== generationRef.current) {
        return
      }
      if (poll.status === 'pending') {
        intervalSeconds = poll.pollIntervalSeconds ?? intervalSeconds
        continue
      }
      if (poll.status === 'connected') {
        setState({ phase: 'idle' })
        await onConnected()
        return
      }
      setState({ phase: 'error', error: poll.error })
      return
    }
  }, [onConnected])

  const copyCode = useCallback(async (code: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // Clipboard unavailable; the code is visible for manual entry.
    }
  }, [])

  if (state.phase === 'awaiting') {
    const { flow } = state
    return (
      <div className="flex flex-col items-center gap-3 rounded-md border border-border bg-card p-4">
        <p className="text-[13px] text-muted-foreground">
          {translate(
            'auto.components.github-panel.GitHubSignInPanel.enterCode',
            'GitHub should have opened in your browser. Enter this code there:'
          )}
        </p>
        <div className="flex items-center gap-2">
          <code className="rounded-md bg-muted px-3 py-1.5 font-mono text-lg tracking-widest">
            {flow.userCode}
          </code>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={translate(
              'auto.components.github-panel.GitHubSignInPanel.copyCode',
              'Copy code'
            )}
            onClick={() => void copyCode(flow.userCode)}
          >
            {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
          </Button>
        </div>
        <div className="flex items-center gap-2 text-[12px] text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" />
          {translate(
            'auto.components.github-panel.GitHubSignInPanel.waiting',
            'Waiting for authorization…'
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void window.api.shell.openUrl(flow.verificationUri)}
          >
            {translate(
              'auto.components.github-panel.GitHubSignInPanel.openGithub',
              'Open GitHub again'
            )}
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={cancel}>
            {translate('auto.components.github-panel.GitHubSignInPanel.cancel', 'Cancel')}
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col items-center gap-2">
      <Button
        type="button"
        onClick={() => void start()}
        disabled={state.phase === 'starting'}
        className="gap-2"
      >
        {state.phase === 'starting' ? (
          <Loader2 className="size-4 animate-spin" />
        ) : (
          <Github className="size-4" />
        )}
        {translate('auto.components.github-panel.GitHubSignInPanel.signIn', 'Sign in with GitHub')}
      </Button>
      {state.phase === 'error' ? (
        <p className="max-w-sm text-center text-[12px] text-destructive">{state.error}</p>
      ) : null}
    </div>
  )
}

function PersonalAccessTokenSection({
  onConnected
}: {
  onConnected: () => Promise<void>
}): React.JSX.Element {
  const [token, setToken] = useState('')
  const [connecting, setConnecting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const connect = useCallback(async (): Promise<void> => {
    if (!token.trim() || connecting) {
      return
    }
    setConnecting(true)
    setError(null)
    try {
      const result = await window.api.githubAuth.connectWithToken({ token: token.trim() })
      if (!result.ok) {
        setError(result.error)
        return
      }
      setToken('')
      await onConnected()
    } catch {
      setError(
        translate(
          'auto.components.github-panel.GitHubSignInPanel.connectFailed',
          'Could not connect. Try again.'
        )
      )
    } finally {
      setConnecting(false)
    }
  }, [token, connecting, onConnected])

  return (
    <div className="flex w-full max-w-sm flex-col items-stretch gap-2">
      <div className="flex items-center gap-2">
        <Input
          type="password"
          value={token}
          onChange={(event) => {
            setToken(event.target.value)
            setError(null)
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              void connect()
            }
          }}
          placeholder={translate(
            'auto.components.github-panel.GitHubSignInPanel.tokenPlaceholder',
            'Personal access token'
          )}
          aria-label={translate(
            'auto.components.github-panel.GitHubSignInPanel.tokenPlaceholder',
            'Personal access token'
          )}
          className="h-8 text-[13px]"
        />
        <Button
          type="button"
          size="sm"
          onClick={() => void connect()}
          disabled={!token.trim() || connecting}
        >
          {connecting ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            translate('auto.components.github-panel.GitHubSignInPanel.connect', 'Connect')
          )}
        </Button>
      </div>
      {error ? <p className="text-[12px] text-destructive">{error}</p> : null}
      <button
        type="button"
        className="self-center text-[12px] text-muted-foreground underline-offset-2 hover:underline"
        onClick={() =>
          void window.api.shell.openUrl(
            'https://github.com/settings/tokens/new?scopes=repo&description=Orca'
          )
        }
      >
        {translate(
          'auto.components.github-panel.GitHubSignInPanel.createToken',
          'Create a token with the repo scope on GitHub'
        )}
      </button>
    </div>
  )
}

export function GitHubSignInPanel({
  deviceFlowAvailable,
  onConnected
}: {
  deviceFlowAvailable: boolean
  onConnected: () => Promise<void>
}): React.JSX.Element {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-5 px-6 pb-16">
      <Github className="size-10 text-muted-foreground/60" strokeWidth={1.5} />
      <div className="flex flex-col items-center gap-1 text-center">
        <h2 className="text-[15px] font-semibold">
          {translate(
            'auto.components.github-panel.GitHubSignInPanel.title',
            'Connect your GitHub account'
          )}
        </h2>
        <p className="max-w-md text-[13px] text-muted-foreground">
          {translate(
            'auto.components.github-panel.GitHubSignInPanel.subtitle',
            'List your repositories, clone them locally, and add them as Orca projects.'
          )}
        </p>
      </div>
      {deviceFlowAvailable ? <DeviceFlowSection onConnected={onConnected} /> : null}
      {deviceFlowAvailable ? (
        <div className="flex w-full max-w-sm items-center gap-3 text-[11px] uppercase tracking-wide text-muted-foreground/70">
          <div className="h-px flex-1 bg-border" />
          {translate('auto.components.github-panel.GitHubSignInPanel.or', 'or')}
          <div className="h-px flex-1 bg-border" />
        </div>
      ) : null}
      <PersonalAccessTokenSection onConnected={onConnected} />
    </div>
  )
}
