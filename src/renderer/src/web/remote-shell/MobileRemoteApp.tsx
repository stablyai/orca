import { useCallback, useEffect, useMemo, useState } from 'react'
import WebConnect from '../WebConnect'
import { installWebPreloadApi } from '../web-preload-api'
import {
  clearPairingInputFromAddressBar,
  decideWebPairingStartup,
  readPairingInputFromLocation
} from '../web-pairing'
import {
  createStoredWebRuntimeEnvironment,
  readStoredWebRuntimeEnvironment,
  saveStoredWebRuntimeEnvironment
} from '../web-runtime-environment'
import { MobileTaskHome } from './views/MobileTaskHome'
import { MobileChatView } from './views/MobileChatView'
import { useMobileRemoteWorkspaces } from './use-mobile-remote-workspaces'
import { useMobileStructuredSession } from './use-mobile-structured-session'
import { mobileSessionTitle } from './mobile-remote-model'
import { parseMobileRemoteHash } from './mobile-route'

function storedHostName(fallback: string): string {
  return readStoredWebRuntimeEnvironment()?.name?.trim() || fallback
}

/**
 * The mobile shell reuses the desktop web bundle but owns its own startup:
 * `/remote#pairing=<offer>` is saved exactly like `/web-index.html#pairing=...`,
 * then the compact task list is shown instead of the desktop App.
 */
export function MobileRemoteApp(): React.JSX.Element {
  const hashParams = useMemo(() => parseMobileRemoteHash(window.location.hash), [])
  const initialPairingInput = useMemo(
    () => hashParams.pairingInput ?? readPairingInputFromLocation(window.location),
    [hashParams.pairingInput]
  )
  const startup = useMemo(
    () =>
      decideWebPairingStartup({
        initialPairingInput,
        hasStoredEnvironment: readStoredWebRuntimeEnvironment() !== null
      }),
    [initialPairingInput]
  )
  const [ready, setReady] = useState(false)
  const [hostName, setHostName] = useState(
    () => hashParams.hostName?.trim() || storedHostName('Orca Desktop')
  )

  useEffect(() => {
    if (startup.kind === 'auto-save-runtime-offer') {
      saveStoredWebRuntimeEnvironment(
        createStoredWebRuntimeEnvironment({
          name: 'Orca Server',
          offer: startup.offer,
          previousEnvironment: readStoredWebRuntimeEnvironment()
        })
      )
      clearPairingInputFromAddressBar()
      installWebPreloadApi()
      setHostName(storedHostName('Orca Desktop'))
      setReady(true)
    } else if (startup.kind === 'use-stored-environment') {
      installWebPreloadApi()
      setHostName(storedHostName('Orca Desktop'))
      setReady(true)
    }
  }, [startup])

  const handleConnected = useCallback(() => {
    installWebPreloadApi()
    setHostName(storedHostName('Orca Desktop'))
    setReady(true)
  }, [])

  if (!ready) {
    return (
      <WebConnect
        initialPairingInput={
          startup.kind === 'show-connect' ? startup.initialPairingInput : null
        }
        onConnected={handleConnected}
      />
    )
  }

  return <MobileRemoteShell hostName={hostName} />
}

function MobileRemoteShell({ hostName }: { hostName: string }): React.JSX.Element {
  const { workspaces, sessions, connectionState, loading, error, refresh } =
    useMobileRemoteWorkspaces()
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null)

  const selectedTitle = useMemo(() => {
    if (!selectedSessionId) {
      return ''
    }
    const session = sessions.get(selectedSessionId)
    if (session) {
      return mobileSessionTitle(session)
    }
    for (const workspace of workspaces) {
      const card = workspace.sessions.find((candidate) => candidate.sessionId === selectedSessionId)
      if (card) {
        return card.title
      }
    }
    return 'Agent task'
  }, [selectedSessionId, sessions, workspaces])

  if (selectedSessionId) {
    return (
      <MobileChatScreen
        sessionId={selectedSessionId}
        title={selectedTitle}
        connectionState={connectionState}
        onBack={() => setSelectedSessionId(null)}
      />
    )
  }

  return (
    <MobileTaskHome
      hostName={hostName}
      connectionState={connectionState}
      workspaces={workspaces}
      loading={loading}
      error={error}
      onRefresh={refresh}
      onSelectSession={setSelectedSessionId}
    />
  )
}

function MobileChatScreen({
  sessionId,
  title,
  connectionState,
  onBack
}: {
  sessionId: string
  title: string
  connectionState: 'connecting' | 'connected' | 'offline'
  onBack: () => void
}): React.JSX.Element {
  const session = useMobileStructuredSession(sessionId)
  return (
    <MobileChatView
      title={title}
      messages={session.messages}
      pendingInteraction={session.pendingInteraction}
      connectionState={connectionState}
      sending={session.sending}
      resolving={session.resolving}
      error={session.error}
      onSendPrompt={(text) => void session.sendPrompt(text)}
      onResolveInteraction={(interactionId, decision) =>
        void session.resolveInteraction(interactionId, decision)
      }
      onStop={() => void session.stop()}
      onBack={onBack}
    />
  )
}
