import type { JSX } from 'react'
import { useAppStore } from '@/store'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'

export function FeatureTourNudge(): JSX.Element | null {
  const visible = useAppStore((s) => s.featureTourNudgeVisible)
  const activeModal = useAppStore((s) => s.activeModal)
  const updateStatus = useAppStore((s) => s.updateStatus)
  const openModal = useAppStore((s) => s.openModal)
  const shouldRender = visible && activeModal !== 'feature-wall'
  const updateCardVisible = updateStatus.state !== 'idle' && updateStatus.state !== 'not-available'

  if (!shouldRender) {
    return null
  }

  const handleOpenTour = (): void => {
    openModal('feature-wall', { source: 'popup' })
  }

  return (
    <div
      className={cn(
        'fixed right-4 z-40 w-[360px] max-w-[calc(100vw-32px)]',
        'max-[480px]:left-4 max-[480px]:right-4 max-[480px]:w-auto',
        // Why: UpdateCard owns bottom-10 when visible; keep this education
        // card nearby without covering update actions.
        updateCardVisible ? 'bottom-[220px]' : 'bottom-10'
      )}
    >
      {/* Why: this nudge is the first-agent education surface; keep it persistent
          until the user opens the tour instead of adding a dismiss path. */}
      <Card className="gap-0 overflow-hidden py-0" role="complementary" aria-label="Explore Orca">
        <div className="flex flex-col gap-3 p-3.5">
          <div className="min-w-0 space-y-0.5">
            <div className="text-[11px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
              Explore Orca
            </div>
            <h3 className="truncate text-sm font-semibold">See what Orca can do</h3>
          </div>

          <p
            className="line-clamp-2 text-xs leading-snug text-muted-foreground"
            data-feature-tour-nudge-caption
          >
            A quick walkthrough of the workflows built into Orca.
          </p>
          <p className="text-xs leading-snug text-muted-foreground">
            Reopen any time from Help &gt; Explore Orca.
          </p>

          <Button variant="default" size="sm" className="w-full" onClick={handleOpenTour}>
            Take the tour
          </Button>
        </div>
      </Card>
    </div>
  )
}
