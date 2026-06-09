import { useCallback, useEffect, useId, useRef, useState, type ReactElement } from 'react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { DriverState } from '@/lib/pane-manager/mobile-driver-state'
import { shouldFocusMobileDriverAction } from './mobile-driver-overlay-focus'
import {
  createMobileDriverOverlayCollapseState,
  getMobileDriverOverlayCollapseState
} from './mobile-driver-overlay-collapse'
import { translate } from '@/i18n/i18n'

type Props = {
  driver: DriverState
  hasFitOverride: boolean
  onAction: () => void | Promise<void>
  /** Identifier class on the rendered root, used by e2e selectors. */
  rootClassName?: string
}

// Why: see docs/mobile-presence-lock.md. Driving state preserves output streaming
// so the chip mode lets users keep watching; held-fit state has no live output to
// preserve, so it stays loud until Restore.
export function MobileDriverOverlay({
  driver,
  hasFitOverride,
  onAction,
  rootClassName
}: Props): ReactElement | null {
  const isMobileDriving = driver.kind === 'mobile'
  const isHeldAtPhoneFit = !isMobileDriving && hasFitOverride
  const driverClientId = driver.kind === 'mobile' ? driver.clientId : null

  const [collapseState, setCollapseState] = useState(() =>
    createMobileDriverOverlayCollapseState(driverClientId)
  )
  const [actionPending, setActionPending] = useState(false)
  const mountedRef = useRef(false)

  const setOverlayRootRef = useCallback((node: HTMLDivElement | null): void => {
    mountedRef.current = node !== null
    if (node) {
      // Why: take-back can resolve after the overlay renders null; a later
      // mobile session must not inherit the stale disabled state.
      setActionPending(false)
    }
  }, [])

  const currentCollapseState = getMobileDriverOverlayCollapseState(collapseState, driverClientId)
  // Why: a new mobile actor must be loud even if the prior driver was collapsed.
  if (currentCollapseState !== collapseState) {
    setCollapseState(currentCollapseState)
  }
  const collapsed = currentCollapseState.collapsed

  if (!isMobileDriving && !isHeldAtPhoneFit) {
    return null
  }

  const handleAction = async (): Promise<void> => {
    if (actionPending) {
      return
    }
    setActionPending(true)
    try {
      await onAction()
    } finally {
      if (mountedRef.current) {
        setActionPending(false)
      }
    }
  }

  if (isHeldAtPhoneFit) {
    return (
      <LoudOverlay
        eyebrow="Held at phone size"
        title={translate("auto.components.terminal.pane.MobileDriverOverlay.faa367dc74", "This terminal is sized for your mobile app")}
        body="The session is still being held at the dimensions your phone last reported. Restore to use it on your desktop."
        actionLabel="Restore desktop size"
        actionPending={actionPending}
        onAction={handleAction}
        tone="held"
        rootRef={setOverlayRootRef}
        rootClassName={rootClassName}
      />
    )
  }

  if (collapsed) {
    return (
      <LockChip
        actionPending={actionPending}
        onAction={handleAction}
        onExpand={() => setCollapseState(createMobileDriverOverlayCollapseState(driverClientId))}
        rootRef={setOverlayRootRef}
        rootClassName={rootClassName}
      />
    )
  }

  return (
    <LoudOverlay
      eyebrow="Mobile is driving this terminal"
      title={translate("auto.components.terminal.pane.MobileDriverOverlay.3eed73394f", "Your keyboard is paused")}
      body="Output below is being typed from your phone. Take back to resume typing on the desktop, or collapse to keep watching."
      actionLabel="Take back"
      actionPending={actionPending}
      onAction={handleAction}
      onCollapse={() => setCollapseState({ driverClientId, collapsed: true })}
      tone="driving"
      rootRef={setOverlayRootRef}
      rootClassName={rootClassName}
    />
  )
}

type LoudOverlayProps = {
  eyebrow: string
  title: string
  body: string
  actionLabel: string
  actionPending: boolean
  onAction: () => void | Promise<void>
  onCollapse?: () => void
  tone: 'driving' | 'held'
  rootRef?: (node: HTMLDivElement | null) => void
  rootClassName?: string
}

function LoudOverlay({
  eyebrow,
  title,
  body,
  actionLabel,
  actionPending,
  onAction,
  onCollapse,
  tone,
  rootRef: outerRootRef,
  rootClassName
}: LoudOverlayProps): ReactElement {
  const titleId = useId()
  const bodyId = useId()
  const rootRef = useRef<HTMLDivElement>(null)
  const actionRef = useRef<HTMLButtonElement>(null)
  const setRootRef = useCallback(
    (node: HTMLDivElement | null): void => {
      rootRef.current = node
      outerRootRef?.(node)
    },
    [outerRootRef]
  )
  // Why: focus the recovery action on mount only when the user isn't already
  // typing into another input (composer, command palette, settings field).
  // Unconditional autoFocus yanks focus on every overlay mount, so a phone
  // taking the floor while the desktop user is typing elsewhere would route
  // the next Space/Enter into Take back / Restore. See PR #1899 follow-up.
  useEffect(() => {
    const paneScope = rootRef.current?.parentElement
    if (shouldFocusMobileDriverAction(document.activeElement, document.body, paneScope)) {
      actionRef.current?.focus()
    }
  }, [])
  // Why: terminal output is still useful status while mobile owns input, so the
  // lock UI must not add a pane-wide scrim or blur over the live stream.
  return (
    <div
      ref={setRootRef}
      role="dialog"
      aria-live="assertive"
      aria-labelledby={titleId}
      aria-describedby={bodyId}
      className={cn(
        'pointer-events-none absolute inset-0 z-50 flex items-center justify-center p-6',
        rootClassName
      )}
    >
      <div className="pointer-events-auto flex w-full max-w-[30rem] flex-col gap-3 rounded-lg border border-border bg-card p-6 pb-5 text-card-foreground shadow-xs">
        <div
          className={cn(
            'flex items-center gap-1.5 text-xs font-medium',
            tone === 'driving' ? 'text-foreground' : 'text-muted-foreground'
          )}
        >
          <span aria-hidden="true">●</span>
          <span>{eyebrow}</span>
        </div>
        <div id={titleId} className="text-base font-semibold leading-tight">
          {title}
        </div>
        <div id={bodyId} className="text-sm leading-relaxed text-muted-foreground">
          {body}
        </div>
        <div className="mt-1 flex justify-end gap-2">
          {onCollapse && (
            <Button type="button" variant="outline" size="sm" onClick={onCollapse}>
              {translate("auto.components.terminal.pane.MobileDriverOverlay.7cffad954c", "Collapse")}</Button>
          )}
          {/* Focus is moved to this button only when no user input is active; see effect above. */}
          <Button
            ref={actionRef}
            type="button"
            variant="default"
            size="sm"
            onClick={onAction}
            disabled={actionPending}
          >
            {actionLabel}
          </Button>
        </div>
      </div>
    </div>
  )
}

type ChipProps = {
  actionPending: boolean
  onAction: () => void | Promise<void>
  onExpand: () => void
  rootRef?: (node: HTMLDivElement | null) => void
  rootClassName?: string
}

function LockChip({
  actionPending,
  onAction,
  onExpand,
  rootRef,
  rootClassName
}: ChipProps): ReactElement {
  return (
    <div
      ref={rootRef}
      className={cn(
        'absolute right-2 top-2 z-50 flex items-center gap-1.5 rounded-full border border-border bg-card px-2 py-1 text-xs font-medium text-card-foreground shadow-xs',
        rootClassName
      )}
    >
      <span aria-hidden="true" className="size-2 rounded-full bg-foreground" />
      <Button
        type="button"
        variant="ghost"
        size="xs"
        className="px-1 font-medium"
        onClick={onExpand}
      >
        {translate("auto.components.terminal.pane.MobileDriverOverlay.c44659e09f", "Mobile driving")}</Button>
      <Button type="button" variant="default" size="xs" onClick={onAction} disabled={actionPending}>
        {translate("auto.components.terminal.pane.MobileDriverOverlay.c6460cf584", "Take back")}</Button>
    </div>
  )
}
