import React from 'react'
import { Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { BaseRefPicker } from '@/components/settings/BaseRefPicker'
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
import { SourceControlAgentActionDialog } from '../../SourceControlAgentActionDialog'
import { SourceControlTextGenerationDialog } from '../ai/text-generation-dialog'
import { SourceControlDiscardDialog } from '../commit/discard-dialog'

type AgentDialogProps = React.ComponentProps<typeof SourceControlAgentActionDialog>
type BaseRefPickerProps = React.ComponentProps<typeof BaseRefPicker>
type DiscardDialogProps = React.ComponentProps<typeof SourceControlDiscardDialog>
type TextGenerationDialogProps = React.ComponentProps<typeof SourceControlTextGenerationDialog>

export function SourceControlDialogLayer({
  clearNotesOpen,
  clearNotesDescription,
  clearNotesCount,
  isClearingNotes,
  onDismissClearNotes,
  onConfirmClearNotes,
  pendingDiscard,
  onCancelDiscard,
  onConfirmDiscard,
  baseRefDialogOpen,
  onBaseRefDialogOpenChange,
  baseRefRepoId,
  pickerBaseRef,
  onSelectBaseRef,
  onUsePrimaryBaseRef,
  sourceControlAiActionsVisible,
  resolveConflictsComposerOpen,
  onResolveConflictsComposerOpenChange,
  resolveConflictsPrompt,
  worktreeId,
  groupId,
  connectionId,
  repoId,
  launchPlatform,
  savedResolveConflictsAgentId,
  savedResolveConflictsCommandInputTemplate,
  savedResolveConflictsAgentArgs,
  onSaveAgentDefault,
  onOpenSourceControlAiSettings,
  commitGenerationDialogOpen,
  onCommitGenerationDialogOpenChange,
  pullRequestGenerationDialogOpen,
  onPullRequestGenerationDialogOpenChange,
  settings,
  repo,
  discoveryHostKey,
  linkedIssue,
  onGenerateCommitMessage,
  onSaveCommitMessageDefaults,
  onGeneratePullRequestFields,
  onSavePullRequestDefaults
}: {
  clearNotesOpen: boolean
  clearNotesDescription: string
  clearNotesCount: number
  isClearingNotes: boolean
  onDismissClearNotes: () => void
  onConfirmClearNotes: () => void
  pendingDiscard: DiscardDialogProps['pendingDiscard']
  onCancelDiscard: DiscardDialogProps['onCancel']
  onConfirmDiscard: DiscardDialogProps['onConfirm']
  baseRefDialogOpen: boolean
  onBaseRefDialogOpenChange: (open: boolean) => void
  baseRefRepoId: string
  pickerBaseRef: BaseRefPickerProps['currentBaseRef']
  onSelectBaseRef: BaseRefPickerProps['onSelect']
  onUsePrimaryBaseRef: NonNullable<BaseRefPickerProps['onUsePrimary']>
  sourceControlAiActionsVisible: boolean
  resolveConflictsComposerOpen: boolean
  onResolveConflictsComposerOpenChange: AgentDialogProps['onOpenChange']
  resolveConflictsPrompt: string
  worktreeId: AgentDialogProps['worktreeId']
  groupId: AgentDialogProps['groupId']
  connectionId: AgentDialogProps['connectionId']
  repoId: AgentDialogProps['repoId']
  launchPlatform: AgentDialogProps['launchPlatform']
  savedResolveConflictsAgentId: AgentDialogProps['savedAgentId']
  savedResolveConflictsCommandInputTemplate: AgentDialogProps['savedCommandInputTemplate']
  savedResolveConflictsAgentArgs: AgentDialogProps['savedAgentArgs']
  onSaveAgentDefault: AgentDialogProps['onSaveAgentDefault']
  onOpenSourceControlAiSettings: AgentDialogProps['onOpenSettings']
  commitGenerationDialogOpen: boolean
  onCommitGenerationDialogOpenChange: TextGenerationDialogProps['onOpenChange']
  pullRequestGenerationDialogOpen: boolean
  onPullRequestGenerationDialogOpenChange: TextGenerationDialogProps['onOpenChange']
  settings: TextGenerationDialogProps['settings']
  repo: TextGenerationDialogProps['repo']
  discoveryHostKey: string
  linkedIssue: TextGenerationDialogProps['linkedIssue']
  onGenerateCommitMessage: TextGenerationDialogProps['onGenerate']
  onSaveCommitMessageDefaults: TextGenerationDialogProps['onSaveDefaults']
  onGeneratePullRequestFields: TextGenerationDialogProps['onGenerate']
  onSavePullRequestDefaults: TextGenerationDialogProps['onSaveDefaults']
}): React.JSX.Element {
  return (
    <>
      <Dialog
        open={clearNotesOpen}
        onOpenChange={(open) => {
          if (!open && !isClearingNotes) {
            onDismissClearNotes()
          }
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="text-sm">
              {translate('auto.components.right.sidebar.SourceControl.574d2f4413', 'Clear Notes')}
            </DialogTitle>
            <DialogDescription className="text-xs">{clearNotesDescription}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={onDismissClearNotes}
              disabled={isClearingNotes}
            >
              {translate('auto.components.right.sidebar.SourceControl.05bb8f4a48', 'Cancel')}
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={onConfirmClearNotes}
              disabled={isClearingNotes || clearNotesCount === 0}
            >
              <Trash2 className="size-4" />
              {translate('auto.components.right.sidebar.SourceControl.574d2f4413', 'Clear Notes')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <SourceControlDiscardDialog
        pendingDiscard={pendingDiscard}
        onCancel={onCancelDiscard}
        onConfirm={onConfirmDiscard}
      />

      <Dialog open={baseRefDialogOpen} onOpenChange={onBaseRefDialogOpenChange}>
        <DialogContent className="flex max-h-[min(85vh,36rem)] max-w-xl flex-col overflow-hidden">
          <DialogHeader className="shrink-0">
            <DialogTitle className="text-sm">
              {translate(
                'auto.components.right.sidebar.SourceControl.476b77745b',
                'Change Base Ref'
              )}
            </DialogTitle>
            <DialogDescription className="text-xs">
              {translate(
                'auto.components.right.sidebar.SourceControl.c9ad22888e',
                'Pick the branch compare target for this repository.'
              )}
            </DialogDescription>
          </DialogHeader>
          <div className="min-h-0 overflow-y-auto scrollbar-sleek">
            <BaseRefPicker
              repoId={baseRefRepoId}
              currentBaseRef={pickerBaseRef}
              onSelect={onSelectBaseRef}
              onUsePrimary={onUsePrimaryBaseRef}
            />
          </div>
        </DialogContent>
      </Dialog>

      <SourceControlAgentActionDialog
        open={sourceControlAiActionsVisible && resolveConflictsComposerOpen}
        onOpenChange={onResolveConflictsComposerOpenChange}
        actionId="resolveConflicts"
        title={translate(
          'auto.components.right.sidebar.SourceControl.19652ddd76',
          'Resolve Conflicts With AI'
        )}
        description={translate(
          'auto.components.right.sidebar.SourceControl.901140f47d',
          'Review and edit the full command input before starting an agent.'
        )}
        baseCommandInput={resolveConflictsPrompt}
        worktreeId={worktreeId}
        groupId={groupId}
        connectionId={connectionId}
        repoId={repoId}
        promptDelivery="submit-after-ready"
        launchPlatform={launchPlatform}
        launchSource="conflict_resolution"
        savedAgentId={savedResolveConflictsAgentId}
        savedCommandInputTemplate={savedResolveConflictsCommandInputTemplate}
        savedAgentArgs={savedResolveConflictsAgentArgs}
        onSaveAgentDefault={onSaveAgentDefault}
        onOpenSettings={onOpenSourceControlAiSettings}
        onLaunched={() =>
          toast.success(
            translate(
              'auto.components.right.sidebar.SourceControl.e48caaf0dd',
              'Started an AI agent for the conflicts.'
            )
          )
        }
      />
      <SourceControlTextGenerationDialog
        open={sourceControlAiActionsVisible && commitGenerationDialogOpen}
        onOpenChange={onCommitGenerationDialogOpenChange}
        actionId="commitMessage"
        title={translate(
          'auto.components.right.sidebar.SourceControl.6b122529d4',
          'Generate Commit Message'
        )}
        description={translate(
          'auto.components.right.sidebar.SourceControl.f4c766f1ca',
          'Choose the agent and command template for this run.'
        )}
        generateLabel="Generate"
        settings={settings}
        repo={repo}
        discoveryHostKey={discoveryHostKey}
        linkedIssue={linkedIssue}
        onGenerate={onGenerateCommitMessage}
        onSaveDefaults={onSaveCommitMessageDefaults}
      />
      <SourceControlTextGenerationDialog
        open={sourceControlAiActionsVisible && pullRequestGenerationDialogOpen}
        onOpenChange={onPullRequestGenerationDialogOpenChange}
        actionId="pullRequest"
        title={translate(
          'auto.components.right.sidebar.SourceControl.1a6a6e0bc5',
          'Generate Hosted Review Details'
        )}
        description={translate(
          'auto.components.right.sidebar.SourceControl.f4c766f1ca',
          'Choose the agent and command template for this run.'
        )}
        generateLabel="Generate"
        settings={settings}
        repo={repo}
        discoveryHostKey={discoveryHostKey}
        linkedIssue={linkedIssue}
        onGenerate={onGeneratePullRequestFields}
        onSaveDefaults={onSavePullRequestDefaults}
      />
    </>
  )
}
