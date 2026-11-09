import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import { makePaneKey } from '../../../../shared/workspace-layout/stable-pane-id'
import type { ManagedPane } from '@/lib/pane-manager/pane-manager-types'
import {
  abandonAgentSignIn,
  openSignInPage,
  cancelAgentSignIn,
  readAgentSignInGate,
  retryAgentSignIn,
  skipAgentSignIn,
  startAgentSignIn,
  submitAgentSignInCode,
  switchToCodeSignIn,
  useAgentSignInGate
} from '@/lib/agent-sign-in/agent-sign-in-gate'
import type { TerminalPaneController } from '../terminal-pane/controller/use-terminal-pane-controller'
import { AgentSignInCard, type AgentSignInCardActions } from './AgentSignInCard'
import { AgentSignInOverlay } from './AgentSignInOverlay'

// Why a delay: remounts unmount the portal too; only a pane that stays gone abandons its sign-in.
const ABANDON_CHECK_MS = 1_000
const mountedPortals = new Map<string, number>()

function cardActions(key: string): AgentSignInCardActions {
  return {
    signIn: () => startAgentSignIn(key),
    retry: () => void retryAgentSignIn(key),
    useCode: () => void switchToCodeSignIn(key),
    submitCode: (code) => void submitAgentSignInCode(key, code),
    openLink: openSignInPage,
    copyText: (text) => void window.api.ui.writeClipboardText(text),
    cancel: () => cancelAgentSignIn(key),
    skip: () => skipAgentSignIn(key)
  }
}

function AgentSignInPanePortal({
  pane,
  tabId
}: {
  pane: ManagedPane
  tabId: string
}): React.JSX.Element | null {
  const key = makePaneKey(tabId, pane.leafId)
  const gate = useAgentSignInGate(key)
  const held = gate !== null
  useEffect(() => {
    if (!held) {
      return
    }
    mountedPortals.set(key, (mountedPortals.get(key) ?? 0) + 1)
    return () => {
      mountedPortals.set(key, (mountedPortals.get(key) ?? 1) - 1)
      setTimeout(() => {
        if ((mountedPortals.get(key) ?? 0) <= 0 && readAgentSignInGate(key)) {
          mountedPortals.delete(key)
          abandonAgentSignIn(key)
        }
      }, ABANDON_CHECK_MS)
    }
  }, [held, key])
  if (!gate) {
    return null
  }
  return createPortal(
    <AgentSignInOverlay>
      <AgentSignInCard gate={gate} actions={cardActions(key)} />
    </AgentSignInOverlay>,
    pane.container,
    `agent-sign-in-${pane.id}`
  )
}

/** Each pane whose agent launch waits for sign-in on its host shows the card instead of a terminal. */
export function AgentSignInPanePortals({
  controller
}: {
  controller: TerminalPaneController
}): React.JSX.Element {
  const { managedPanes, tabId } = controller
  return (
    <>
      {managedPanes.map((pane) => (
        <AgentSignInPanePortal key={pane.id} pane={pane} tabId={tabId} />
      ))}
    </>
  )
}
