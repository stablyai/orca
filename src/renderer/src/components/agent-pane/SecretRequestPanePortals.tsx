import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useAppStore } from '@/store'
import { useTranslate } from '@/i18n/use-translate'
import type { ManagedPane } from '@/lib/pane-manager/pane-manager-types'
import {
  useSecretRequests,
  type SecretRequestEntry
} from '@/lib/secret-requests/secret-request-store'
import {
  routeSecretRequests,
  secretRequestAgentName
} from '@/lib/secret-requests/secret-request-routing'
import { makePaneKey } from '../../../../shared/workspace-layout/stable-pane-id'
import { parseRemoteRuntimePtyId } from '../../../../shared/remote-runtime/remote-runtime-pty-id'
import type { TerminalPaneController } from '../terminal-pane/controller/use-terminal-pane-controller'
import { SecretRequestCard, secretRequestTitle } from './SecretRequestCard'
import {
  registerSecretRequestCard,
  setSecretRequestSlot,
  useSecretRequestSlots
} from './secret-request-focus'
import { useSecretRequestCard } from './use-secret-request-card'

function SecretRequestPaneCardBody({
  entry,
  more,
  pane,
  paneKey,
  ptyId,
  worktreeId,
  onAskingPane,
  primary,
  announcement
}: {
  entry: SecretRequestEntry
  more: number
  pane: ManagedPane
  paneKey: string
  ptyId: string
  worktreeId: string
  onAskingPane: boolean
  primary: boolean
  announcement: string
}): React.JSX.Element {
  const { model, actions } = useSecretRequestCard({ entry, more, worktreeId, ptyId, onAskingPane })
  const cardRef = useRef<HTMLDivElement>(null)
  // Filled after mount so screen readers hear it once; a live region's initial text isn't read.
  const [spoken, setSpoken] = useState('')
  const open = model.phase === 'open'
  useEffect(() => {
    if (!open) {
      setSpoken('')
      return
    }
    const timer = window.setTimeout(() => setSpoken(announcement), 150)
    return () => window.clearTimeout(timer)
  }, [open, announcement])

  // F6 reaches this card from its pane (or from anywhere when it's on the active pane), and the card
  // hands focus back to where it came from when it goes away.
  useLayoutEffect(
    () =>
      registerSecretRequestCard({
        paneKey,
        container: pane.container,
        card: () => cardRef.current,
        primary
      }),
    [paneKey, pane.container, primary]
  )

  return (
    <div
      data-secret-request-overlay=""
      className="pointer-events-none absolute inset-x-3 top-10 z-30 flex justify-end"
    >
      <span role="status" className="sr-only">
        {spoken}
      </span>
      <SecretRequestCard
        model={model}
        actions={actions}
        rootRef={cardRef}
        className="pointer-events-auto max-w-md"
      />
    </div>
  )
}

function SecretRequestPaneSlot({
  pane,
  tabId,
  visible,
  primary,
  worktreeId
}: {
  pane: ManagedPane
  tabId: string
  visible: boolean
  primary: boolean
  worktreeId: string
}): React.JSX.Element | null {
  const t = useTranslate()
  const paneKey = makePaneKey(tabId, pane.leafId)
  const ptyId = useAppStore(
    (state) => state.terminalLayoutsByTabId[tabId]?.ptyIdsByLeafId?.[pane.leafId] ?? null
  )
  const remote = ptyId ? parseRemoteRuntimePtyId(ptyId) : null
  const environmentId = remote?.environmentId ?? null
  const handle = remote?.handle ?? null
  useEffect(() => {
    if (!environmentId) {
      return
    }
    setSecretRequestSlot(paneKey, { paneKey, environmentId, handle, visible, primary })
    return () => setSecretRequestSlot(paneKey, null)
  }, [paneKey, environmentId, handle, visible, primary])

  const requests = useSecretRequests()
  const slots = useSecretRequestSlots()
  const mine = useMemo(
    () => (environmentId ? (routeSecretRequests(requests, slots).get(paneKey) ?? []) : []),
    [environmentId, requests, slots, paneKey]
  )
  const first = mine[0]
  if (!first || !ptyId) {
    return null
  }
  const { entry } = first
  return createPortal(
    <SecretRequestPaneCardBody
      // A new request starts from an empty field and Personal.
      key={`${entry.environmentId}:${entry.event.requestId}`}
      entry={entry}
      more={mine.length - 1}
      pane={pane}
      paneKey={paneKey}
      ptyId={ptyId}
      worktreeId={worktreeId}
      onAskingPane={first.onAskingPane}
      primary={primary}
      announcement={t('secretRequest.announce', '{{title}}. Press F6 to answer.', {
        title: secretRequestTitle(secretRequestAgentName(entry.event.agent), entry.event.name, t)
      })}
    />,
    pane.container,
    `secret-request-${pane.id}`
  )
}

/** S4-b: a pane whose agent asked for a secret shows the request card over its top edge. */
export function SecretRequestPanePortals({
  controller
}: {
  controller: TerminalPaneController
}): React.JSX.Element {
  const { managedPanes, tabId, activePane, isActive, worktreeId } = controller
  return (
    <>
      {managedPanes.map((pane) => (
        <SecretRequestPaneSlot
          key={pane.id}
          pane={pane}
          tabId={tabId}
          worktreeId={worktreeId}
          visible={isActive}
          primary={isActive && activePane?.id === pane.id}
        />
      ))}
    </>
  )
}
