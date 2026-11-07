import * as VisuallyHidden from 'radix-ui/visually-hidden'
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
        // Electron webviews cannot paint within transformed ancestors; suppress the sheet slide. Reserve macOS traffic-light width; the variable is zero on Windows/Linux.
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
