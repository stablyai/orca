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
import { useTranslate } from '@/i18n/use-translate'
import type { DirectWorkItemSetupRequest } from '@/lib/workspace/creation/work-item/direct-work-item-setup'
import { WorkspaceSetupSection } from './WorkspaceSetupSection'
import { selectWorkspaceSetupCopy } from './workspace-setup-section-model'
import { getDirectWorkspaceSetupLabels } from './direct-work-item-setup-copy'

export function DirectWorkItemSetupDialog({
  request
}: {
  request: DirectWorkItemSetupRequest
}): React.JSX.Element {
  const t = useTranslate()
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
            {t('components.newWorkspace.directSetup.run', 'Run setup')} · {request.repoName}
          </DialogTitle>
        </DialogHeader>
        <WorkspaceSetupSection
          setupConfig={inspection.kind === 'needs-modal' ? inspection.setupConfig : null}
          copy={selectWorkspaceSetupCopy(
            inspection.kind === 'needs-modal' ? inspection.setupConfig : null,
            getDirectWorkspaceSetupLabels(t)
          )}
          requiresExplicitSetupChoice
          resolvedSetupDecision={null}
          setupDecision={null}
          onSetupDecisionChange={request.choose}
          renderDescription={(text) => <DialogDescription size="compact">{text}</DialogDescription>}
          unavailable={
            inspection.kind === 'unavailable'
              ? {
                  message: t(
                    'components.newWorkspace.setupCheckFailed',
                    'Could not check setup configuration. Try again.'
                  ),
                  retryLabel: t('components.newWorkspace.directSetup.retry', 'Retry'),
                  checking,
                  retry: () => void retry()
                }
              : undefined
          }
        />
        <DialogFooter>
          <Button variant="ghost" onClick={request.cancel}>
            {t('components.newWorkspace.directSetup.cancel', 'Cancel')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
