import React from 'react'
import { toast } from 'sonner'
import type { useAppStore } from '@/store'
import { SourceControlAgentActionDialog } from '@/components/right-sidebar/source-control/ai/SourceControlAgentActionDialog'
import { readSourceControlLaunchRecipeAgentId } from '../../../../../shared/source-control/ai/source-control-launch-agent-selection'
import type { SourceControlActionRecipe } from '../../../../../shared/source-control/ai/recipes/source-control-ai-actions'
import { useTranslate } from '@/i18n/use-translate'
import type { GitHubWorkItem } from '../../../../../shared/github/work-items/work-item-types'
import { saveFixChecksActionDefault, startFixChecksFromDialog } from './fix-launch'

export function ChecksFixDialog({
  fixChecksComposerPrompt,
  setFixChecksComposerPrompt,
  fixChecksRecipe,
  fixChecksLaunchPlatform,
  repoConnectionId,
  targetRepoId,
  item,
  updateSettings,
  updateRepo
}: {
  fixChecksComposerPrompt: string | null
  setFixChecksComposerPrompt: (value: string | null) => void
  fixChecksRecipe: SourceControlActionRecipe
  /** Unset when the repo's host has not reported its OS; the launch then reports why. */
  fixChecksLaunchPlatform: NodeJS.Platform | undefined
  repoConnectionId: string | null
  targetRepoId: string | null
  item: GitHubWorkItem
  updateSettings: ReturnType<typeof useAppStore.getState>['updateSettings']
  updateRepo: ReturnType<typeof useAppStore.getState>['updateRepo']
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <SourceControlAgentActionDialog
      open={fixChecksComposerPrompt !== null}
      onOpenChange={(open) => {
        if (!open) {
          setFixChecksComposerPrompt(null)
        }
      }}
      actionId="fixChecks"
      title={t('auto.components.PullRequestPage.a053bdd082', 'Fix Broken Checks With AI')}
      description={t(
        'auto.components.PullRequestPage.ddfd42f460',
        'Review the prompt before starting an agent.'
      )}
      baseCommandInput={fixChecksComposerPrompt ?? ''}
      connectionId={repoConnectionId}
      repoId={targetRepoId}
      promptDelivery="submit-after-ready"
      launchPlatform={fixChecksLaunchPlatform}
      launchSource="task_page"
      savedAgentId={readSourceControlLaunchRecipeAgentId(fixChecksRecipe)}
      savedCommandInputTemplate={fixChecksRecipe.commandInputTemplate ?? null}
      savedAgentArgs={fixChecksRecipe.agentArgs ?? null}
      onSaveAgentDefault={(target, actionId, recipe) =>
        saveFixChecksActionDefault(target, actionId, recipe, updateSettings, updateRepo)
      }
      onLaunched={() => {
        toast.success(
          t(
            'auto.components.PullRequestPage.85e62c5266',
            'Started an AI agent for the broken checks.'
          )
        )
      }}
      onStart={(launch) => startFixChecksFromDialog({ targetRepoId, item, ...launch })}
    />
  )
}
