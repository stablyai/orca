import React from 'react'
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
import type { SmartWorkspaceNameFieldController } from './use-smart-workspace-name-field-controller'

export function renderSmartWorkspaceCrossRepoDialog(
  controller: SmartWorkspaceNameFieldController
): React.JSX.Element {
  const {
    crossRepoPrompt,
    dismissCrossRepoPrompt,
    crossRepoSwitchTitle,
    formatCrossRepoSwitchDescription,
    selectedRepo,
    crossRepoSwitchFallbackLabel,
    handleUseCurrentRepo,
    acceptGitHubLink,
    allowCrossRepoProjectAdd,
    handleAddMatchingRepo
  } = controller

  return (
    <Dialog
      open={crossRepoPrompt !== null}
      onOpenChange={(next) => !next && dismissCrossRepoPrompt()}
    >
      <DialogContent className="min-w-0 sm:max-w-md">
        <DialogHeader className="min-w-0">
          <DialogTitle>{crossRepoSwitchTitle}</DialogTitle>
          <DialogDescription className="break-words">
            {formatCrossRepoSwitchDescription(
              `${crossRepoPrompt?.link.slug.owner ?? ''}/${crossRepoPrompt?.link.slug.repo ?? ''}`
            )}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="min-w-0 sm:flex-wrap">
          <Button variant="outline" onClick={dismissCrossRepoPrompt}>
            {translate(
              'auto.components.new.workspace.SmartWorkspaceNameField.6859e2896c',
              'Cancel'
            )}
          </Button>
          <Button
            variant="outline"
            className="min-w-0 max-w-full"
            onClick={() => void handleUseCurrentRepo()}
          >
            <span className="min-w-0 truncate">
              {translate(
                'auto.components.new.workspace.SmartWorkspaceNameField.keepRepo',
                'Keep {{name}}',
                { name: selectedRepo?.displayName ?? crossRepoSwitchFallbackLabel }
              )}
            </span>
          </Button>
          {crossRepoPrompt?.matchingRepo ? (
            <Button
              className="min-w-0 max-w-full"
              onClick={() => void acceptGitHubLink(crossRepoPrompt.matchingRepo!)}
            >
              <span className="min-w-0 truncate">
                {translate(
                  'auto.components.new.workspace.SmartWorkspaceNameField.switchToRepo',
                  'Switch to {{name}}',
                  { name: crossRepoPrompt.matchingRepo.displayName }
                )}
              </span>
            </Button>
          ) : allowCrossRepoProjectAdd ? (
            <Button onClick={() => void handleAddMatchingRepo()}>
              {translate(
                'auto.components.new.workspace.SmartWorkspaceNameField.e57c53727c',
                'Add project...'
              )}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
