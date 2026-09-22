import { VisuallyHidden } from 'radix-ui'
import type { ArtifactListItem } from '../../../../shared/artifacts'
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet'
import { translate } from '@/i18n/i18n'
import { artifactName } from './artifact-display-labels'
import { ArtifactDetailHeader } from './ArtifactDetailHeader'
import { ArtifactPreview } from './ArtifactPreview'

export function ArtifactDetailDrawer({
  item,
  deleting,
  onClose,
  onDelete
}: {
  item: ArtifactListItem | null
  deleting: boolean
  onClose: () => void
  onDelete: (item: ArtifactListItem) => void
}): React.JSX.Element {
  return (
    <Sheet open={item !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent
        side="right"
        showCloseButton={false}
        // Why: Electron webviews do not paint inside transformed ancestors, so this
        // sheet must not use the default slide translate.
        // Why: leave the native macOS traffic-light area uncovered when the drawer is
        // intentionally wider than the standard sheet max-width. The var resolves to 0px on
        // Windows and Linux, whose controls sit on the right edge instead.
        className="h-full w-[min(96rem,calc(100vw-var(--mac-traffic-lights-width,0px)))] max-w-none translate-x-0 p-0 sm:max-w-[min(96rem,calc(100vw-var(--mac-traffic-lights-width,0px)))] data-[state=closed]:translate-x-0 data-[state=open]:translate-x-0"
      >
        {item ? (
          <div className="flex h-full min-h-0 flex-col">
            <VisuallyHidden.Root asChild>
              <SheetDescription>
                {translate(
                  'auto.components.artifacts.ArtifactDetailDrawer.description',
                  'Preview and manage this shared artifact.'
                )}
              </SheetDescription>
            </VisuallyHidden.Root>
            <ArtifactDetailHeader
              deleting={deleting}
              item={item}
              title={
                <SheetTitle className="truncate text-base font-semibold">
                  {artifactName(item)}
                </SheetTitle>
              }
              onClose={onClose}
              onDelete={onDelete}
            />
            <ArtifactPreview shareUrl={item.shareUrl} />
          </div>
        ) : null}
      </SheetContent>
    </Sheet>
  )
}
