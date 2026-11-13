import { useLayoutEffect, useRef, useState, type JSX } from 'react'
import { Import, MoreHorizontal } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { defineFixture } from '../../component-fixtures/component-fixture'
import { getContextualTour } from '../../../../shared/contextual-tours'
import type { BrowserExtensionsBanner } from '../../../../shared/browser/extensions/browser-extensions-banner'
import { withBrowserExtensionsBannerLook } from './browser-extensions-banner-look'
import {
  ContextualTourOverlaySurface,
  type ActiveTourRenderState
} from './ContextualTourOverlaySurface'

function BrowserExtensionsTourPreview({ look }: { look: BrowserExtensionsBanner }): JSX.Element {
  const targetRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLElement | null>(null)
  const [renderState, setRenderState] = useState<ActiveTourRenderState | null>(null)
  const step = getContextualTour('browser-extensions').steps[0]

  useLayoutEffect(() => {
    const target = targetRef.current
    if (!target) {
      return
    }
    setRenderState(
      withBrowserExtensionsBannerLook(
        {
          rect: target.getBoundingClientRect(),
          targetElement: target,
          progress: { current: 1, total: 1 },
          title: step.title,
          body: step.body,
          primaryAction: step.primaryAction,
          secondaryAction: step.secondaryAction,
          preferredPlacement: step.preferredPlacement,
          isLastStep: true,
          isFirstStep: true,
          panelHost: null
        },
        look
      )
    )
  }, [look, step])

  return (
    <div className="h-[340px] pr-40">
      <div className="flex items-center justify-end gap-1 border-b border-border px-2 py-1.5">
        <div className="mr-auto h-7 flex-1 rounded-md border border-border" />
        <Button type="button" variant="secondary" size="xs">
          <Import className="size-3.5" />
          Import
        </Button>
        <Button ref={targetRef} type="button" size="icon-xs" variant="ghost">
          <MoreHorizontal className="size-4" />
        </Button>
      </div>
      {renderState ? (
        <ContextualTourOverlaySurface
          activeTourId="browser-extensions"
          renderState={renderState}
          panelRef={panelRef}
          panelHost={null}
          onSkip={() => {}}
          onBack={() => {}}
          onNext={() => {}}
          onStepAction={() => {}}
          onOverlayKeyDownCapture={() => {}}
        />
      ) : null}
    </div>
  )
}

export const browserExtensions = defineFixture({
  width: 700,
  render: () => <BrowserExtensionsTourPreview look="plain_bring" />
})

export const browserExtensionsColored = defineFixture({
  width: 700,
  render: () => <BrowserExtensionsTourPreview look="colored_bring" />
})

export const browserExtensionsEveryday = defineFixture({
  width: 700,
  render: () => <BrowserExtensionsTourPreview look="plain_everyday" />
})

export const browserExtensionsEverydayColored = defineFixture({
  width: 700,
  render: () => <BrowserExtensionsTourPreview look="colored_everyday" />
})

export const browserExtensionsNarrow = defineFixture({
  width: 520,
  render: () => <BrowserExtensionsTourPreview look="colored_everyday" />
})
