import { createPortal } from 'react-dom'
import {
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type JSX,
  type KeyboardEvent,
  type RefObject
} from 'react'
import { ArrowLeft, ArrowRight, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useAppStore } from '@/store'
import type {
  ContextualTourId,
  ContextualTourStepPlacement,
  ContextualTourStepControl,
  ContextualTourStepAction
} from '../../../../shared/contextual-tours'
import { ContextualTourArrow } from './ContextualTourArrow'
import { ContextualTourControl } from './ContextualTourControl'
import { ContextualTourProgressDots } from './ContextualTourProgressDots'
import {
  watchContextualTourFloatingPosition,
  type ContextualTourFloatingPosition
} from './contextual-tour-floating-position'
import { translate } from '@/i18n/i18n'

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
const SKIP_BUTTON_SELECTOR = 'button[aria-label^="Skip"], button[aria-label="Dismiss tour"]'

export type ActiveTourRenderState = {
  rect: DOMRect
  targetElement: Element
  progress: { current: number; total: number }
  title: string
  body: string
  control?: ContextualTourStepControl
  primaryAction?: ContextualTourStepAction
  secondaryAction?: ContextualTourStepAction
  preferredPlacement?: ContextualTourStepPlacement
  targetPulse?: boolean
  hidePrimaryAction?: boolean
  isLastStep: boolean
  isFirstStep: boolean
  panelHost: HTMLElement | null
}

type ContextualTourOverlaySurfaceProps = {
  activeTourId: ContextualTourId
  renderState: ActiveTourRenderState
  panelRef: RefObject<HTMLElement | null>
  panelHost: HTMLElement | null
  onSkip: (id: ContextualTourId) => void
  onBack: () => void
  onNext: () => void
  onStepAction: (action: ContextualTourStepAction) => void
  onOverlayKeyDownCapture: (event: KeyboardEvent<HTMLDivElement>) => void
}

if (typeof window !== 'undefined') {
  const guardedWindow = window as Window & {
    __orcaContextualTourGlobalKeyGuardInstalled?: boolean
  }
  if (!guardedWindow.__orcaContextualTourGlobalKeyGuardInstalled) {
    guardedWindow.__orcaContextualTourGlobalKeyGuardInstalled = true
    window.addEventListener('keydown', handleContextualTourGlobalKeyDown, true)
  }
}

const PANEL_BASE_CLASSES =
  'orca-contextual-tour-panel rounded-lg border border-border text-popover-foreground backdrop-blur-[2px]'

const PANEL_ANIMATION_CLASSES = 'animate-in fade-in-0 zoom-in-95 duration-200 ease-out'

export function ContextualTourOverlaySurface({
  activeTourId,
  renderState,
  panelRef,
  panelHost,
  onSkip,
  onBack,
  onNext,
  onStepAction,
  onOverlayKeyDownCapture
}: ContextualTourOverlaySurfaceProps): JSX.Element {
  const arrowRef = useRef<SVGSVGElement | null>(null)
  const [floatingPosition, setFloatingPosition] = useState<ContextualTourFloatingPosition | null>(
    null
  )
  const panelHostSlot = panelHost?.getAttribute('data-slot')
  const hostedPanelClass = cn(
    PANEL_BASE_CLASSES,
    PANEL_ANIMATION_CLASSES,
    panelHostSlot === 'sheet-content'
      ? 'absolute z-[80] w-[min(20rem,calc(100%-1.5rem))]'
      : 'absolute z-[80] w-[min(20rem,calc(100%-2rem))]'
  )
  const floatingPanelClass = cn(
    PANEL_BASE_CLASSES,
    PANEL_ANIMATION_CLASSES,
    'fixed w-[min(20rem,calc(100vw-1.5rem))]'
  )

  const stepKey = `${activeTourId}-${renderState.progress.current}`
  const defaultPrimaryAction = {
    kind: renderState.isLastStep ? 'complete' : 'next',
    label: renderState.isLastStep ? 'Done' : 'Next'
  } satisfies ContextualTourStepAction
  const primaryAction =
    renderState.primaryAction ?? (renderState.hidePrimaryAction ? null : defaultPrimaryAction)
  const showTargetRings = renderState.targetPulse === true
  const targetRingStyle = showTargetRings
    ? ({
        left: renderState.rect.left,
        top: renderState.rect.top,
        width: renderState.rect.width,
        height: renderState.rect.height
      } satisfies CSSProperties)
    : undefined
  const unresolvedPanelPosition = {
    left: 0,
    top: 0,
    visibility: 'hidden'
  } satisfies CSSProperties

  useLayoutEffect(() => {
    const panelElement = panelRef.current
    const arrowElement = arrowRef.current
    if (!panelElement || !arrowElement) {
      setFloatingPosition(null)
      return
    }

    // Why: hide only until the new step's first measurement; autoUpdate then
    // tracks the target continuously, so the panel never blinks mid-step.
    setFloatingPosition(null)
    return watchContextualTourFloatingPosition({
      arrowElement,
      floatingElement: panelElement,
      panelHost,
      preferredPlacement: renderState.preferredPlacement,
      targetElement: renderState.targetElement,
      onPosition: setFloatingPosition
    })
  }, [panelHost, panelRef, renderState.preferredPlacement, renderState.targetElement])

  const panel = (
    <section
      ref={panelRef}
      aria-live="polite"
      aria-label={renderState.title}
      data-contextual-tour-panel=""
      data-placement={floatingPosition?.panelPlacement ?? undefined}
      role="dialog"
      tabIndex={-1}
      className={panelHost ? hostedPanelClass : floatingPanelClass}
      style={floatingPosition?.panelPosition ?? unresolvedPanelPosition}
    >
      <ContextualTourArrow
        arrowRef={arrowRef}
        placement={floatingPosition?.panelPlacement ?? renderState.preferredPlacement ?? 'right'}
        style={floatingPosition?.arrowPosition ?? { visibility: 'hidden' }}
      />
      <div key={stepKey} className="animate-in fade-in-0 duration-150 ease-out p-4">
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={
            renderState.isLastStep
              ? translate(
                  'auto.components.contextual.tours.ContextualTourOverlaySurface.d974f32a83',
                  'Dismiss tour'
                )
              : translate(
                  'auto.components.contextual.tours.ContextualTourOverlaySurface.4f86e2a10b',
                  'Skip tour'
                )
          }
          onClick={() => onSkip(activeTourId)}
          className="absolute right-2 top-2 text-muted-foreground hover:text-foreground"
        >
          <X />
        </Button>
        <h2 className="pr-6 text-sm font-semibold tracking-tight text-foreground">
          {renderState.title}
        </h2>
        <p className="mt-1.5 text-xs leading-5 text-muted-foreground">{renderState.body}</p>
        {renderState.control ? <ContextualTourControl control={renderState.control} /> : null}
        <div className="mt-3.5 flex items-center justify-between gap-3">
          <ContextualTourProgressDots
            current={renderState.progress.current}
            total={renderState.progress.total}
          />
          <div className="flex items-center gap-1.5">
            {!renderState.isFirstStep ? (
              <Button
                type="button"
                variant="ghost"
                size="xs"
                aria-label={translate(
                  'auto.components.contextual.tours.ContextualTourOverlaySurface.4a9568f773',
                  'Back'
                )}
                onClick={onBack}
              >
                <ArrowLeft />
                {translate(
                  'auto.components.contextual.tours.ContextualTourOverlaySurface.4a9568f773',
                  'Back'
                )}
              </Button>
            ) : null}
            {renderState.secondaryAction ? (
              <Button
                type="button"
                variant="ghost"
                size="xs"
                onClick={() => onStepAction(renderState.secondaryAction!)}
              >
                {renderState.secondaryAction.label}
              </Button>
            ) : null}
            {primaryAction ? (
              <Button
                type="button"
                size="xs"
                onClick={
                  primaryAction.kind === defaultPrimaryAction.kind &&
                  primaryAction.label === defaultPrimaryAction.label
                    ? onNext
                    : () => onStepAction(primaryAction)
                }
              >
                {primaryAction.label}
                {primaryAction.kind === 'next' && !renderState.isLastStep ? <ArrowRight /> : null}
              </Button>
            ) : null}
          </div>
        </div>
      </div>
    </section>
  )

  return (
    <div
      className={cn(
        // Why: tours are callouts, not modality. Let pointer events reach the
        // underlying surface; only the panel itself captures interaction.
        'fixed inset-0 z-[70] pointer-events-none'
      )}
      data-contextual-tour-overlay=""
      role="presentation"
      onKeyDownCapture={onOverlayKeyDownCapture}
    >
      {showTargetRings ? (
        <div
          aria-hidden="true"
          className="orca-contextual-tour-target-rings fixed z-[75]"
          data-contextual-tour-target-rings=""
          style={targetRingStyle}
        />
      ) : null}
      <div className="pointer-events-auto">
        {panelHost ? createPortal(panel, panelHost) : panel}
      </div>
    </div>
  )
}

export function handleContextualTourOverlayKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
  if (event.key === 'Escape') {
    event.preventDefault()
    event.stopPropagation()
    const skipButton = event.currentTarget.querySelector<HTMLButtonElement>(SKIP_BUTTON_SELECTOR)
    skipButton?.click()
  }

  // Why: tours are non-modal callouts over live UI. Keyboard users must be able
  // to tab into the highlighted surface just as pointer users can click it.
}

export function handleContextualTourGlobalKeyDown(event: globalThis.KeyboardEvent): void {
  const activeTourId = useAppStore.getState().activeContextualTourId
  if (!activeTourId || event.key !== 'Escape') {
    return
  }

  const overlay = document.querySelector<HTMLElement>('[data-contextual-tour-overlay]')
  const focusRoot = document.querySelector<HTMLElement>('[data-contextual-tour-panel]') ?? overlay
  if (!overlay || !focusRoot) {
    return
  }

  event.preventDefault()
  event.stopImmediatePropagation()
  const skipButton = focusRoot.querySelector<HTMLButtonElement>(SKIP_BUTTON_SELECTOR)
  if (skipButton) {
    skipButton.click()
  }
}

export function getContextualTourFocusableElements(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (element) => element.getClientRects().length > 0 || element === document.activeElement
  )
}
