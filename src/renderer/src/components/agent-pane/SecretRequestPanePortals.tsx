import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { useAppStore } from '@/store'
import { useTranslate } from '@/i18n/use-translate'
import type { ManagedPane } from '@/lib/pane-manager/pane-manager-types'
import { useSecretRequests } from '@/lib/secret-requests/secret-request-store'
import {
  routeSecretRequests,
  secretRequestAgentName,
  type SecretRequestPaneSlot
} from '@/lib/secret-requests/secret-request-routing'
import { makePaneKey } from '../../../../shared/workspace-layout/stable-pane-id'
import { parseRemoteRuntimePtyId } from '../../../../shared/remote-runtime/remote-runtime-pty-id'
import type { TerminalPaneController } from '../terminal-pane/controller/use-terminal-pane-controller'
import { SecretRequestCard, secretRequestTitle } from './SecretRequestCard'
import { useSecretRequestCard } from './use-secret-request-card'

// Every mounted pane on a remote host, across tabs, so a request lands on exactly one of them.
const slots = new Map<string, SecretRequestPaneSlot>()
const slotListeners = new Set<() => void>()
let slotSnapshot: readonly SecretRequestPaneSlot[] = []

function publishSlots(): void {
  slotSnapshot = [...slots.values()]
  for (const listener of slotListeners) {
    listener()
  }
}

function setSlot(slot: SecretRequestPaneSlot | null, paneKey: string): void {
  const current = slots.get(paneKey)
  if (slot === null) {
    if (current) {
      slots.delete(paneKey)
      publishSlots()
    }
    return
  }
  if (
    current?.environmentId === slot.environmentId &&
    current.handle === slot.handle &&
    current.primary === slot.primary
  ) {
    return
  }
  slots.set(paneKey, slot)
  publishSlots()
}

function useSlots(): readonly SecretRequestPaneSlot[] {
  return useSyncExternalStore(
    (listener) => {
      slotListeners.add(listener)
      return () => slotListeners.delete(listener)
    },
    () => slotSnapshot,
    () => slotSnapshot
  )
}

function SecretRequestPaneCard({
  pane,
  paneKey,
  ptyId,
  worktreeId,
  primary
}: {
  pane: ManagedPane
  paneKey: string
  ptyId: string
  worktreeId: string
  primary: boolean
}): React.JSX.Element | null {
  const t = useTranslate()
  const requests = useSecretRequests()
  const allSlots = useSlots()
  const routed = useMemo(() => routeSecretRequests(requests, allSlots), [requests, allSlots])
  const mine = routed.get(paneKey) ?? []
  const entry = mine[0]
  if (!entry) {
    return null
  }
  return createPortal(
    <SecretRequestPaneCardBody
      // A new request starts from an empty field and Personal.
      key={`${entry.environmentId}:${entry.event.requestId}`}
      entry={entry}
      more={mine.length - 1}
      ptyId={ptyId}
      worktreeId={worktreeId}
      primary={primary}
      announcement={t('secretRequest.announce', '{{title}}. Press F6 to answer.', {
        title: secretRequestTitle(secretRequestAgentName(entry.event.agent), entry.event.name, t)
      })}
    />,
    pane.container,
    `secret-request-${pane.id}`
  )
}

function SecretRequestPaneCardBody({
  entry,
  more,
  ptyId,
  worktreeId,
  primary,
  announcement
}: {
  entry: Parameters<typeof useSecretRequestCard>[0]['entry']
  more: number
  ptyId: string
  worktreeId: string
  primary: boolean
  announcement: string
}): React.JSX.Element {
  const { model, actions } = useSecretRequestCard({ entry, more, worktreeId, ptyId })
  const fieldRef = useRef<HTMLDivElement>(null)
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
  // F6 reaches the card from the terminal; the card itself never takes focus when it appears.
  useEffect(() => {
    if (!primary) {
      return
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'F6' || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
        return
      }
      const field = fieldRef.current?.querySelector<HTMLElement>('input, textarea')
      const target = field ?? fieldRef.current
      if (target) {
        event.preventDefault()
        event.stopPropagation()
        target.focus()
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [primary])
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
        inputRef={fieldRef}
        className="pointer-events-auto max-w-md"
      />
    </div>
  )
}

function SecretRequestPaneSlotTracker({
  pane,
  tabId,
  primary,
  worktreeId
}: {
  pane: ManagedPane
  tabId: string
  primary: boolean
  worktreeId: string
}): React.JSX.Element | null {
  const paneKey = makePaneKey(tabId, pane.leafId)
  const ptyId = useAppStore(
    (state) => state.terminalLayoutsByTabId[tabId]?.ptyIdsByLeafId?.[pane.leafId] ?? null
  )
  const remote = ptyId ? parseRemoteRuntimePtyId(ptyId) : null
  const environmentId = remote?.environmentId ?? null
  const handle = remote?.handle ?? null
  useEffect(() => {
    if (!environmentId) {
      setSlot(null, paneKey)
      return
    }
    setSlot({ paneKey, environmentId, handle, primary }, paneKey)
    return () => setSlot(null, paneKey)
  }, [paneKey, environmentId, handle, primary])
  if (!environmentId || !ptyId) {
    return null
  }
  return (
    <SecretRequestPaneCard
      pane={pane}
      paneKey={paneKey}
      ptyId={ptyId}
      worktreeId={worktreeId}
      primary={primary}
    />
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
        <SecretRequestPaneSlotTracker
          key={pane.id}
          pane={pane}
          tabId={tabId}
          worktreeId={worktreeId}
          primary={isActive && activePane?.id === pane.id}
        />
      ))}
    </>
  )
}
