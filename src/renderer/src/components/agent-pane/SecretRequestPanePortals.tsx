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
import { secretRequestDoneTitle } from './SecretRequestCardParts'
import {
  registerSecretRequestCard,
  setSecretRequestSlot,
  useSecretRequestSlots
} from './secret-request-focus'
import { useSecretRequestCard } from './use-secret-request-card'

const SAVED_DISMISS_MS = 6000
/** Keys that don't type into the pane: F6 reaches the card, modifiers alone do nothing. */
const NON_TYPING_KEYS = new Set(['F6', 'Shift', 'Control', 'Alt', 'Meta', 'CapsLock'])

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
  const t = useTranslate()
  const { model, actions: cardActions } = useSecretRequestCard({
    entry,
    more,
    worktreeId,
    ptyId,
    onAskingPane
  })
  const cardRef = useRef<HTMLDivElement>(null)
  const [hovered, setHovered] = useState(false)
  const [focused, setFocused] = useState(false)
  const actions = {
    ...cardActions,
    onFocusChange: (next: boolean) => {
      setFocused(next)
      cardActions.onFocusChange?.(next)
    }
  }
  // The hook's actions are new every render; the timers below must not restart with them.
  const latest = useRef(cardActions)
  useLayoutEffect(() => {
    latest.current = cardActions
  })
  const done = model.phase === 'saved' || model.phase === 'savedAfterExpiry'
  const doneTitle = done
    ? secretRequestDoneTitle(
        {
          agent: model.agent,
          name: model.name,
          scope: model.scope,
          toldAgent: model.phase === 'saved'
        },
        t
      )
    : ''
  // Filled after mount so screen readers hear it once; a live region's initial text isn't read. The
  // saved state is announced here too, before it dismisses itself.
  const [spoken, setSpoken] = useState('')
  const open = model.phase === 'open'
  const toSpeak = open ? announcement : doneTitle
  useEffect(() => {
    if (!toSpeak) {
      setSpoken('')
      return
    }
    const timer = window.setTimeout(() => setSpoken(toSpeak), 150)
    return () => window.clearTimeout(timer)
  }, [toSpeak])

  // Saved is a done state: it goes away on its own after a few seconds, never while it's in use.
  useEffect(() => {
    if (!done || hovered || focused) {
      return
    }
    const timer = window.setTimeout(() => latest.current.onDismiss(), SAVED_DISMISS_MS)
    return () => window.clearTimeout(timer)
  }, [done, hovered, focused])

  // While it asks, scrolling or typing in the pane folds it to the pill instead of covering output.
  const foldable = !done && !model.collapsed
  useEffect(() => {
    if (!foldable) {
      return
    }
    const container = pane.container
    const outsideCard = (target: EventTarget | null): boolean =>
      !(target instanceof Node && cardRef.current?.contains(target))
    const onWheel = (event: WheelEvent): void => {
      if (outsideCard(event.target)) {
        latest.current.onCollapse()
      }
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (outsideCard(event.target) && !NON_TYPING_KEYS.has(event.key)) {
        latest.current.onCollapse()
      }
    }
    container.addEventListener('wheel', onWheel, { capture: true, passive: true })
    container.addEventListener('keydown', onKeyDown, { capture: true })
    return () => {
      container.removeEventListener('wheel', onWheel, { capture: true })
      container.removeEventListener('keydown', onKeyDown, { capture: true })
    }
  }, [foldable, pane.container])

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
      <div
        className="pointer-events-auto w-full max-w-md"
        onPointerEnter={() => setHovered(true)}
        onPointerLeave={() => setHovered(false)}
      >
        <SecretRequestCard model={model} actions={actions} rootRef={cardRef} />
      </div>
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

/** A pane whose agent asked for a secret shows the request card over its top edge. */
export function SecretRequestPanePortals({
  controller
}: {
  controller: TerminalPaneController
}): React.JSX.Element {
  const { managedPanes, tabId, activePane, isActive, isRendererVisible, worktreeId } = controller
  return (
    <>
      {managedPanes.map((pane) => (
        <SecretRequestPaneSlot
          key={pane.id}
          pane={pane}
          tabId={tabId}
          worktreeId={worktreeId}
          // On screen, even in a split group that isn't the active one.
          visible={isRendererVisible}
          primary={isActive && activePane?.id === pane.id}
        />
      ))}
    </>
  )
}
