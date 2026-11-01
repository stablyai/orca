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
import { WorkspaceSetupSection } from './WorkspaceSetupSection'
import { selectWorkspaceSetupCopy } from './workspace-setup-section-model'
import { getDirectWorkspaceSetupLabels } from './direct-work-item-setup-copy'

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
        </DialogHeader>
        <WorkspaceSetupSection
          setupConfig={inspection.kind === 'needs-modal' ? inspection.setupConfig : null}
          copy={selectWorkspaceSetupCopy(
            inspection.kind === 'needs-modal' ? inspection.setupConfig : null,
            getDirectWorkspaceSetupLabels()
          )}
          requiresExplicitSetupChoice
          resolvedSetupDecision={null}
          setupDecision={null}
          onSetupDecisionChange={request.choose}
          renderDescription={(text) => (
            <DialogDescription className="text-xs">{text}</DialogDescription>
          )}
          unavailable={
            inspection.kind === 'unavailable'
              ? {
                  message: translate(
                    'components.newWorkspace.setupCheckFailed',
                    'Could not check setup configuration. Try again.'
                  ),
                  retryLabel: translate('components.newWorkspace.directSetup.retry', 'Retry'),
                  checking,
                  retry: () => void retry()
                }
              : undefined
          }
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
