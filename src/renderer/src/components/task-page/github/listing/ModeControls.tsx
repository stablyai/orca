import type { TaskPageComposerActionsModel } from '../../use-task-page-composer-actions'
import { RailPageViews } from '@/components/rail-page/RailPageToolbar'
import { useTranslate } from '@/i18n/use-translate'

type Props = { model: TaskPageComposerActionsModel }

export function TaskPageGitHubViews({ model }: Props): React.JSX.Element | null {
  const t = useTranslate()
  const {
    githubModeButtons,
    githubMode,
    activeGithubTaskKind,
    setGithubMode,
    setTaskResumeState,
    handleSelectGithubTaskKind
  } = model
  const selectMode = (mode: (typeof githubModeButtons)[number]['id']): void => {
    if (mode === 'project') {
      setGithubMode('project')
      setTaskResumeState({ githubMode: 'project' })
      return
    }
    setGithubMode('items')
    setTaskResumeState({ githubMode: 'items' })
    handleSelectGithubTaskKind(mode)
  }
  return (
    <RailPageViews
      label={t('auto.components.TaskPage.acef77f7ca', 'GitHub')}
      value={githubMode === 'project' ? 'project' : activeGithubTaskKind}
      onValueChange={selectMode}
      onReselect={selectMode}
      items={githubModeButtons
        .filter((mode) => mode.id !== 'project' || model.projectModeVisible)
        .map((mode) => ({ value: mode.id, label: mode.label }))}
    />
  )
}
