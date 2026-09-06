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
    crossRepoSwitchDescriptionSuffix,
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
            {translate(
              'auto.components.new.workspace.SmartWorkspaceNameField.ad188067ae',
              'The GitHub URL points to'
            )}{' '}
            {crossRepoPrompt?.link.slug.owner}/{crossRepoPrompt?.link.slug.repo}
            {crossRepoSwitchDescriptionSuffix}
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
                'auto.components.new.workspace.SmartWorkspaceNameField.eadf877af5',
                'Keep'
              )}{' '}
              {selectedRepo?.displayName ?? crossRepoSwitchFallbackLabel}
            </span>
          </Button>
          {crossRepoPrompt?.matchingRepo ? (
            <Button
              className="min-w-0 max-w-full"
              onClick={() => void acceptGitHubLink(crossRepoPrompt.matchingRepo!)}
            >
              <span className="min-w-0 truncate">
                {translate(
                  'auto.components.new.workspace.SmartWorkspaceNameField.a76fcb4fa0',
                  'Switch to'
                )}{' '}
                {crossRepoPrompt.matchingRepo.displayName}
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
