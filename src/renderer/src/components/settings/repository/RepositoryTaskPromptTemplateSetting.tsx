import type { Project, ProjectUpdateArgs } from '../../../../../shared/project-types'
import { TaskPromptTemplateSetting } from '../TaskPromptTemplateSetting'

export function RepositoryTaskPromptTemplateSetting({
  project,
  globalTemplate,
  updateProject,
  forceVisible
}: {
  project: Project
  globalTemplate?: string
  updateProject: (
    projectId: string,
    updates: ProjectUpdateArgs['updates']
  ) => void | Promise<unknown>
  forceVisible?: boolean
}): React.JSX.Element {
  return (
    <TaskPromptTemplateSetting
      scope="project"
      value={project.linkedWorkItemPromptTemplate ?? ''}
      globalTemplate={globalTemplate}
      commit={async (value) =>
        (await updateProject(project.id, {
          linkedWorkItemPromptTemplate: value.trim() ? value : null
        })) === true
      }
      forceVisible={forceVisible}
    />
  )
}
