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
} from '../../../../shared/source-control-ai'
import type { SourceControlTextActionId } from '../../../../shared/source-control-ai-actions'
import type { GlobalSettings, Repo } from '../../../../shared/types'
import type { SourceControlAiWriteTarget } from '../../../../shared/source-control-ai-recipe-save'
import { buildBranchNamePrompt } from '../../../../shared/branch-name-from-work'
import { buildCommitMessagePrompt } from '../../../../shared/commit-message-generation'
import { buildPullRequestFieldsPrompt } from '../../../../shared/pull-request-generation'
import {
  SourceControlTextGenerationDialogForm,
  type SourceControlTextGenerationSaveTarget
} from './SourceControlTextGenerationDialogForm'
import { translate } from '@/i18n/i18n'

export { buildCommitMessageGenerationParams } from './SourceControlTextGenerationParams'

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
    [actionId, discoveryHostKey, repo, settings]
  )
  const baseParams = resolved.ok ? resolved.value.params : null
  const recipeLabel =
    actionId === 'commitMessage'
      ? translate(
          'auto.components.right.sidebar.SourceControlTextGenerationDialog.1d156632e1',
          'commit-message recipe'
        )
      : actionId === 'pullRequest'
        ? translate(
            'auto.components.right.sidebar.SourceControlTextGenerationDialog.e935cb4eaa',
            'hosted-review recipe'
          )
        : translate(
            'auto.components.right.sidebar.SourceControlTextGenerationDialog.e3d0a41d63',
            'branch-name recipe'
          )
  const saveTargets: SourceControlTextGenerationSaveTarget[] = repo?.id
    ? [
        {
          target: { type: 'repo', repoId: repo.id },
          label: translate(
            'auto.components.right.sidebar.SourceControlTextGenerationDialog.5959da1e4d',
            'Save for this repository only'
          ),
          successMessage: translate(
            'auto.components.right.sidebar.SourceControlTextGenerationDialog.649f3d1762',
            'Saved {{value0}} for this repository.',
            { value0: recipeLabel }
          )
        },
        {
          target: { type: 'global' },
          label: translate(
            'auto.components.right.sidebar.SourceControlTextGenerationDialog.7f1ec309a4',
            'Save as default for all repositories'
          ),
          successMessage: translate(
            'auto.components.right.sidebar.SourceControlTextGenerationDialog.369167678c',
            'Saved {{value0}} as a global default.',
            { value0: recipeLabel }
          )
        }
      ]
    : [
        {
          target: { type: 'global' },
          label: translate(
            'auto.components.right.sidebar.SourceControlTextGenerationDialog.c5b7fa7cb6',
            'Save as global default'
          ),
          successMessage: translate(
            'auto.components.right.sidebar.SourceControlTextGenerationDialog.369167678c',
            'Saved {{value0}} as a global default.',
            { value0: recipeLabel }
          )
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
            {resolved.error}
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
