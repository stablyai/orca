import { useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import type { DirectWorkItemSetupRequest } from '@/lib/direct-work-item-setup'
import { SetupCommandPreview } from './SetupCommandPreview'
import { WorkspaceSetupChoice } from './WorkspaceSetupChoice'

export function DirectWorkItemSetupDialog({
  request
}: {
  request: DirectWorkItemSetupRequest
}): React.JSX.Element {
  const [inspection, setInspection] = useState(request.inspection)
  const [checking, setChecking] = useState(false)
  const retry = async (): Promise<void> => {
    if (checking || !request.isPending()) {
      return
    }
    setChecking(true)
    const result = await request.inspect()
    if (!request.isPending()) {
      return
    }
    if (result.kind === 'decided') {
      request.choose(result.decision)
      return
    }
    setInspection(result)
    setChecking(false)
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) {
          request.cancel()
        }
      }}
    >
      <DialogContent surface="security" scrollable className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {translate('components.newWorkspace.directSetup.run', 'Run setup')} · {request.repoName}
          </DialogTitle>
          <DialogDescription>
            {translate(
              'components.newWorkspace.directSetup.description',
              'Choose whether to run setup before creating this workspace.'
            )}
          </DialogDescription>
        </DialogHeader>
        {inspection.kind === 'needs-modal' ? (
          <SetupCommandPreview setupConfig={inspection.setupConfig} />
        ) : (
          <div className="space-y-2">
            <p className="text-sm text-muted-foreground">
              {translate(
                'components.newWorkspace.setupCheckFailed',
                'Could not check setup configuration. Try again.'
              )}
            </p>
            <Button variant="outline" disabled={checking} onClick={() => void retry()}>
              {translate('components.newWorkspace.directSetup.retry', 'Retry')}
            </Button>
          </div>
        )}
        <WorkspaceSetupChoice
          runLabel={translate('components.newWorkspace.directSetup.run', 'Run setup')}
          skipLabel={translate('components.newWorkspace.directSetup.skip', 'Skip setup')}
          decision={null}
          onChange={request.choose}
          disabled={checking || inspection.kind !== 'needs-modal'}
        />
        <DialogFooter>
          <Button variant="ghost" onClick={request.cancel}>
            {translate('components.newWorkspace.directSetup.cancel', 'Cancel')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
