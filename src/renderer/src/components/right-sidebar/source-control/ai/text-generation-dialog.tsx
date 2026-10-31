import { textGenerationErrorText } from '@/lib/text-generation-error-copy'
import React, { useMemo } from 'react'
import { TriangleAlert } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import {
  resolveSourceControlAiForOperation,
  type ResolvedSourceControlAiGenerationParams
} from '../../../../../../shared/source-control-ai'
import type { SourceControlTextActionId } from '../../../../../../shared/source-control-ai-actions'
import type { GlobalSettings } from '../../../../../../shared/global-settings-types'
import type { Repo } from '../../../../../../shared/repo-types'
import type { SourceControlAiWriteTarget } from '../../../../../../shared/source-control-ai-recipe-save'
import { buildBranchNamePrompt } from '../../../../../../shared/branch-name-from-work'
import { buildCommitMessagePrompt } from '../../../../../../shared/commit-message-generation'
import { buildPullRequestFieldsPrompt } from '../../../../../../shared/pull-request-generation'
import {
  SourceControlTextGenerationDialogForm,
  type SourceControlTextGenerationSaveTarget
} from './text-generation-dialog-form'
import { translate } from '@/i18n/i18n'
import { useUiLanguageRevision } from '@/i18n/use-ui-language-revision'

export { buildCommitMessageGenerationParams } from './text-generation-params'

type SourceControlTextGenerationBaseDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  settings: GlobalSettings | null
  repo?: Pick<Repo, 'id' | 'sourceControlAi'> | null
  discoveryHostKey: string
  /** Omitted by workspace-less callers (Settings dry-run); `null` means "linked to nothing". */
  linkedIssue?: number | null
  onGenerate: (params: ResolvedSourceControlAiGenerationParams) => void
  onSaveDefaults: (
    target: SourceControlAiWriteTarget,
    params: ResolvedSourceControlAiGenerationParams
  ) => Promise<void> | void
}

type SourceControlTextGenerationDialogProps = SourceControlTextGenerationBaseDialogProps & {
  actionId: SourceControlTextActionId
  title: string
  description: string
  generateLabel: string
}

function buildBasePromptPreview(actionId: SourceControlTextActionId): string {
  switch (actionId) {
    case 'commitMessage':
      return buildCommitMessagePrompt(
        {
          branch: 'feature/example',
          stagedSummary: 'M src/example.ts',
          stagedPatch: 'diff --git a/src/example.ts b/src/example.ts\n+addSourceControlAiPreview()'
        },
        ''
      )
    case 'pullRequest':
      return buildPullRequestFieldsPrompt(
        {
          branch: 'feature/example',
          base: 'main',
          branchChangedByPreparation: false,
          currentTitle: 'Draft title',
          currentBody: 'Draft description',
          currentDraft: false,
          commitSummary: 'a1b2c3d Add Source Control AI prompt previews',
          changeSummary: 'src/example.ts | 12 ++++++++++--',
          patch: 'diff --git a/src/example.ts b/src/example.ts\n+addSourceControlAiPreview()'
        },
        ''
      )
    case 'branchName':
      return buildBranchNamePrompt({
        firstPrompt: 'Add source-control AI prompt previews',
        assistantMessage: 'I will update the generation dialog variable chip preview.'
      })
  }
}

function savedRecipeMessage(actionId: SourceControlTextActionId, scope: 'repo' | 'global'): string {
  switch (actionId) {
    case 'commitMessage':
      return scope === 'repo'
        ? translate(
            'sourceControl.textGeneration.savedCommitRecipeRepo',
            'Saved commit-message recipe for this repository.'
          )
        : translate(
            'sourceControl.textGeneration.savedCommitRecipeGlobal',
            'Saved commit-message recipe as a global default.'
          )
    case 'pullRequest':
      return scope === 'repo'
        ? translate(
            'sourceControl.textGeneration.savedReviewRecipeRepo',
            'Saved hosted-review recipe for this repository.'
          )
        : translate(
            'sourceControl.textGeneration.savedReviewRecipeGlobal',
            'Saved hosted-review recipe as a global default.'
          )
    case 'branchName':
      return scope === 'repo'
        ? translate(
            'sourceControl.textGeneration.savedBranchRecipeRepo',
            'Saved branch-name recipe for this repository.'
          )
        : translate(
            'sourceControl.textGeneration.savedBranchRecipeGlobal',
            'Saved branch-name recipe as a global default.'
          )
  }
}

export function SourceControlTextGenerationDialog({
  actionId,
  title,
  description,
  generateLabel,
  open,
  onOpenChange,
  settings,
  repo,
  discoveryHostKey,
  linkedIssue,
  onGenerate,
  onSaveDefaults
}: SourceControlTextGenerationDialogProps): React.JSX.Element {
  const languageRevision = useUiLanguageRevision()
  const resolved = useMemo(
    () =>
      settings
        ? resolveSourceControlAiForOperation({
            settings,
            repo: repo ?? null,
            operation: actionId,
            discoveryHostKey
          })
        : {
            ok: false as const,
            error: translate(
              'auto.components.right.sidebar.SourceControlTextGenerationDialog.d054d5e0a0',
              'Settings are not loaded.'
            )
          },
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- translate() reads the UI language implicitly.
    [actionId, discoveryHostKey, repo, settings, languageRevision]
  )
  const baseParams = resolved.ok ? resolved.value.params : null
  const saveTargets: SourceControlTextGenerationSaveTarget[] = repo?.id
    ? [
        {
          target: { type: 'repo', repoId: repo.id },
          label: translate(
            'auto.components.right.sidebar.SourceControlTextGenerationDialog.5959da1e4d',
            'Save for this repository only'
          ),
          successMessage: savedRecipeMessage(actionId, 'repo')
        },
        {
          target: { type: 'global' },
          label: translate(
            'auto.components.right.sidebar.SourceControlTextGenerationDialog.7f1ec309a4',
            'Save as default for all repositories'
          ),
          successMessage: savedRecipeMessage(actionId, 'global')
        }
      ]
    : [
        {
          target: { type: 'global' },
          label: translate(
            'auto.components.right.sidebar.SourceControlTextGenerationDialog.c5b7fa7cb6',
            'Save as global default'
          ),
          successMessage: savedRecipeMessage(actionId, 'global')
        }
      ]
  const formKey = open
    ? JSON.stringify([
        actionId,
        baseParams?.agentId ?? '',
        baseParams?.commandInputTemplate ?? '',
        baseParams?.agentArgs ?? '',
        baseParams?.customAgentCommand ?? ''
      ])
    : 'closed'

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="min-w-0 overflow-x-hidden sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="text-sm">{title}</DialogTitle>
          <DialogDescription className="text-xs">{description}</DialogDescription>
        </DialogHeader>

        {!resolved.ok ? (
          <p className="flex items-start gap-1.5 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
            <TriangleAlert className="mt-px size-3.5 shrink-0" />
            {textGenerationErrorText(resolved)}
          </p>
        ) : null}

        <SourceControlTextGenerationDialogForm
          key={formKey}
          actionId={actionId}
          generateLabel={generateLabel}
          settings={settings}
          repo={repo ?? null}
          baseParams={baseParams}
          basePromptPreview={buildBasePromptPreview(actionId)}
          linkedIssue={linkedIssue}
          saveTargets={saveTargets}
          onGenerate={onGenerate}
          onOpenChange={onOpenChange}
          onSaveDefaults={onSaveDefaults}
        />
      </DialogContent>
    </Dialog>
  )
}
