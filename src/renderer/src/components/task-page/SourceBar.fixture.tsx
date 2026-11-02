import { defineFixture } from '../../component-fixtures/component-fixture'
import { TooltipProvider } from '@/components/ui/tooltip'
import { getTaskSourceContextSummary } from '../task-source-context-summary'
import { getSourceOptions } from './task-page-localized-options'
import { TaskPageSourceBar } from './SourceBar'
import type { TaskPageComposerActionsModel } from './use-task-page-composer-actions'

// A fork list (Origin selected) whose saved project is the upstream; the summary names the fork.
const fork = { owner: 'long-fork-owner-organization', repo: 'long-repository-name-for-tasks' }

function ForkSourceBar(): React.JSX.Element {
  const sourceOptions = getSourceOptions()
  const model = {
    visibleSourceOptions: sourceOptions,
    taskSource: 'github',
    taskSourceAvailabilityNoticeByProvider: {},
    taskSourceContextSummary: getTaskSourceContextSummary({
      provider: 'github',
      providerLabel: sourceOptions.find((source) => source.id === 'github')?.label ?? 'GitHub',
      repoContexts: [
        {
          kind: 'task-source',
          provider: 'github',
          projectId: 'project',
          repoId: 'repo',
          hostId: 'local',
          providerIdentity: { provider: 'github', owner: 'upstream-owner', repo: 'project' }
        }
      ],
      repoIdentities: [{ provider: 'github', ...fork }],
      selectedRepoCount: 1
    }),
    linearConnected: false,
    jiraConnected: false
  } as unknown as TaskPageComposerActionsModel
  return (
    <TooltipProvider>
      <div className="bg-background p-2">
        <TaskPageSourceBar model={model} />
      </div>
    </TooltipProvider>
  )
}

export const forkSource = defineFixture({
  width: 1280,
  render: () => <ForkSourceBar />
})
export const forkSourceNarrow = defineFixture({
  width: 720,
  render: () => <ForkSourceBar />
})
