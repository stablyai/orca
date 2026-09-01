import React from 'react'
import { LoaderCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { translate } from '@/i18n/i18n'
import type { ResourceUsageActions } from './use-resource-usage-actions'
import type { ResourceUsageFoundation } from './use-resource-usage-foundation'

export function ResourceUsageKillDialog({
  foundation,
  actions
}: {
  foundation: ResourceUsageFoundation
  actions: ResourceUsageActions
}): React.JSX.Element {
  const { killConfirm, killing, setKillConfirm } = foundation
  const { runKillConfirmed } = actions

  return (
    <Dialog
      open={killConfirm !== null}
      onOpenChange={(next) => {
        if (next) {
          return
        }
        if (killing) {
          return
        }
        setKillConfirm(null)
      }}
    >
      <DialogContent
        className="max-w-md"
        showCloseButton={!killing}
        onPointerDownOutside={(event) => {
          if (killing) {
            event.preventDefault()
          }
        }}
        onEscapeKeyDown={(event) => {
          if (killing) {
            event.preventDefault()
          }
        }}
      >
        <DialogHeader>
          <DialogTitle className="text-sm">
            {translate(
              'auto.components.status.bar.ResourceUsageStatusSegment.e9a5d3c2b1f0',
              'Kill {{value0}}?',
              {
                value0:
                  killConfirm?.label ??
                  translate(
                    'auto.components.status.bar.ResourceUsageStatusSegment.138b99bd80',
                    'this session'
                  )
              }
            )}
          </DialogTitle>
          <DialogDescription className="text-xs">
            {translate(
              'auto.components.status.bar.ResourceUsageStatusSegment.67c4ecda49',
              "Force-quits this terminal. Any unsaved work in the pane is lost. This can't be undone."
            )}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => setKillConfirm(null)} disabled={killing}>
            {translate(
              'auto.components.status.bar.ResourceUsageStatusSegment.946d9f94d0',
              'Cancel'
            )}
          </Button>
          <Button variant="destructive" onClick={() => void runKillConfirmed()} disabled={killing}>
            {killing ? <LoaderCircle className="size-4 animate-spin" /> : null}
            {killing
              ? translate(
                  'auto.components.status.bar.ResourceUsageStatusSegment.41ae4fa725',
                  'Killing…'
                )
              : translate(
                  'auto.components.status.bar.ResourceUsageStatusSegment.b10695d6ce',
                  'Kill session'
                )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
