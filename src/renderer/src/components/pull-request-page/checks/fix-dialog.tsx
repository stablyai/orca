import React from 'react'
import { toast } from 'sonner'
import type { useAppStore } from '@/store'
import { SourceControlAgentActionDialog } from '@/components/right-sidebar/SourceControlAgentActionDialog'
import { readSourceControlLaunchRecipeAgentId } from '@/lib/source-control-launch-agent-selection'
import type { SourceControlActionRecipe } from '../../../../../shared/source-control-ai-actions'
import { translate } from '@/i18n/i18n'
import type { GitHubWorkItem } from '../../../../../shared/github/work-item-types'
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
  fixChecksLaunchPlatform: NodeJS.Platform
  repoConnectionId: string | null
  targetRepoId: string | null
  item: GitHubWorkItem
  updateSettings: ReturnType<typeof useAppStore.getState>['updateSettings']
  updateRepo: ReturnType<typeof useAppStore.getState>['updateRepo']
}): React.JSX.Element {
  return (
    <SourceControlAgentActionDialog
      open={fixChecksComposerPrompt !== null}
      onOpenChange={(open) => {
        if (!open) {
          setFixChecksComposerPrompt(null)
        }
      }}
      actionId="fixChecks"
      title={translate('auto.components.PullRequestPage.a053bdd082', 'Fix Broken Checks With AI')}
      description={translate(
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
          translate(
            'auto.components.PullRequestPage.85e62c5266',
            'Started an AI agent for the broken checks.'
          )
        )
      }}
      onStart={({ agent, commandInput, agentArgs }) =>
        startFixChecksFromDialog({
          targetRepoId,
          item,
          agent,
          commandInput,
          agentArgs
        })
      }
    />
  )
}
