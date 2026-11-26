// Orca's own sign-in to a host server: "Finish in your browser" while the host waits for it. On this
// computer the browser comes back to the host's listener; on a server, its address is pasted back.
import React, { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { useTranslate } from '@/i18n/use-translate'
import { BotToolLogo } from '@/components/bots/apps/BotToolAppRow'
import {
  BotAppBrowserWait,
  BotAppOutcome,
  BotAppStepHeader
} from '@/components/bots/apps/BotAppStepParts'
import { SignInAddressPaste } from '@/components/bots/SignInAddressPaste'
import { botToolErrorMessage } from '@/components/bots/bot-tools-client'
import { BotToolPasteRefused } from '@/components/bots/bot-tool-host-sign-in'
import { RuntimeRpcCallError } from '@/runtime/rpc/calls/runtime-rpc-result'
import { openBotToolSignInPage as openPage } from '@/components/bots/bot-tool-sign-in-state'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import {
  botToolSignInFailureWords,
  botToolSignInPastedQuery,
  type BotToolSignInAttemptView
} from '../../../../../shared/bot-tool-sign-in'
import {
  cancelMcpServerSignIn,
  finishMcpServerSignIn,
  startMcpServerSignIn,
  waitMcpServerSignIn
} from '@/runtime/mcp-servers/mcp-servers-client'
import { mcpServerTitle } from './mcp-server-words'

export type McpSignInServer = { id: string; name: string; detail: string }

type Phase =
  | { kind: 'starting' }
  | { kind: 'waiting'; view: Extract<BotToolSignInAttemptView, { state: 'waiting' }> }
  | { kind: 'finishing' }
  | { kind: 'failed'; line: string }

// A dropped connection retries the wait this often; the attempt lives on the host until it expires.
const RETRY_MS = 2_000

/** The host answered, and will keep refusing: MCP servers went off there, or the server went. */
function hostRefuses(error: unknown): boolean {
  return (
    error instanceof RuntimeRpcCallError &&
    (error.code === 'mcp_servers_off' || error.code === 'mcp_server_gone')
  )
}

function SignInFlow({
  target,
  hostName,
  server,
  onRetry,
  onClose
}: {
  target: RuntimeClientTarget
  hostName: string
  server: McpSignInServer
  onRetry: () => void
  onClose: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const title = mcpServerTitle(server.name)
  const paste = target.kind === 'environment'
  const [phase, setPhase] = useState<Phase>({ kind: 'starting' })
  const flowRef = useRef<string | null>(null)
  // A newer onClose from the parent must not restart the sign-in.
  const closeRef = useRef(onClose)
  useEffect(() => {
    closeRef.current = onClose
  }, [onClose])
  const serverId = server.id
  useEffect(() => {
    let live = true
    const fail = (line: string): void => {
      if (live) {
        setPhase({ kind: 'failed', line })
      }
    }
    const follow = async (flowId: string, revision: number, expiresAt: number): Promise<void> => {
      while (live) {
        let view: BotToolSignInAttemptView
        try {
          view = await waitMcpServerSignIn(target, flowId, revision)
        } catch (error) {
          // A dropped connection retries until the attempt would have expired; the host forgets it then.
          if (Date.now() > expiresAt || hostRefuses(error)) {
            flowRef.current = null
            fail(botToolSignInFailureWords('expired', hostName, t))
            return
          }
          await new Promise((resolve) => setTimeout(resolve, RETRY_MS))
          continue
        }
        if (!live) {
          return
        }
        revision = view.revision
        if (view.state === 'done') {
          flowRef.current = null
          toast.success(
            t('settings.mcpServers.signedInToast', 'Signed in to {{name}}', { name: title })
          )
          closeRef.current()
          return
        }
        if (view.state === 'failed') {
          flowRef.current = null
          fail(botToolSignInFailureWords(view.code, hostName, t))
          return
        }
        setPhase(view.state === 'waiting' ? { kind: 'waiting', view } : { kind: 'finishing' })
      }
    }
    void startMcpServerSignIn(target, serverId, paste ? 'paste' : 'routed').then(
      (view) => {
        if (!live) {
          cancelMcpServerSignIn(target, view.flowId)
          return
        }
        if (view.state === 'failed') {
          fail(botToolSignInFailureWords(view.code, hostName, t))
          return
        }
        if (view.state !== 'waiting') {
          return
        }
        flowRef.current = view.flowId
        openPage(view.authorizationUrl)
        setPhase({ kind: 'waiting', view })
        void follow(view.flowId, view.revision, view.expiresAt)
      },
      (error: unknown) => fail(botToolErrorMessage(error))
    )
    return () => {
      live = false
      // Closing here ends a sign-in the host runs for a paste nobody can make any more.
      if (flowRef.current && paste) {
        cancelMcpServerSignIn(target, flowRef.current)
      }
    }
  }, [target, serverId, paste, hostName, title, t])

  const logo = <BotToolLogo name={server.name} detail={server.detail} size="lg" />
  if (phase.kind === 'failed') {
    return (
      <BotAppOutcome
        logo={logo}
        badge="failed"
        title={t('bots.apps.couldNotSignIn', 'Couldn’t sign in to {{app}}', { app: title })}
        line={phase.line}
        actions={
          <>
            <Button variant="ghost" size="sm" onClick={onClose}>
              {t('bots.apps.close', 'Close')}
            </Button>
            <Button size="sm" onClick={onRetry}>
              {t('bots.composio.tryAgain', 'Try again')}
            </Button>
          </>
        }
      />
    )
  }
  const waiting = phase.kind === 'waiting' ? phase.view : null
  return (
    <BotAppBrowserWait
      logo={logo}
      line={
        phase.kind === 'finishing'
          ? t('bots.toolApp.finishing', 'Finishing sign-in…')
          : t('bots.apps.signInAllow', 'Sign in to {{app}} and allow access.', { app: title })
      }
      onClose={onClose}
      onOpenAgain={waiting ? () => openPage(waiting.authorizationUrl) : undefined}
      footer={
        paste && waiting ? (
          <SignInAddressPaste
            hint={t(
              'components.bots.toolSignIn.pasteLanded',
              'After you sign in, paste the address you landed on.'
            )}
            onFinish={async (address) => {
              const query = botToolSignInPastedQuery(address, waiting)
              if (!query) {
                throw new BotToolPasteRefused(
                  t('settings.mcpServers.pasteRefused', 'That address isn’t from this sign-in.')
                )
              }
              await finishMcpServerSignIn(target, waiting.flowId, query)
            }}
            describeError={botToolErrorMessage}
          />
        ) : null
      }
    />
  )
}

/** Open while `server` is set; each opening starts a new sign-in. */
export function McpServerSignInDialog({
  target,
  hostName,
  server,
  onClose
}: {
  target: RuntimeClientTarget
  hostName: string
  server: McpSignInServer | null
  onClose: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const [attempt, setAttempt] = useState(0)
  return (
    <Dialog open={server !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent
        size="flush"
        showCloseButton={false}
        aria-describedby={undefined}
        className="sm:max-w-115"
      >
        <DialogTitle className="sr-only">
          {t('bots.connectors.finishInBrowser', 'Finish in your browser')}
        </DialogTitle>
        <BotAppStepHeader onClose={onClose} />
        {server ? (
          <SignInFlow
            key={`${server.id}:${attempt}`}
            target={target}
            hostName={hostName}
            server={server}
            onRetry={() => setAttempt((value) => value + 1)}
            onClose={onClose}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  )
}
