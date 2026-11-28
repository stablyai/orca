import type { Repo } from '../../../../shared/repository/repo-types'
import { DEFAULT_REPO_BADGE_COLOR } from '../../../../shared/repository/appearance/repo-badge-color'
import { defineFixture } from '../../component-fixtures/component-fixture'
import { RepoMark } from './RepoMark'

const project: Repo = {
  id: 'forge',
  path: '/projects/forge',
  displayName: 'forge',
  badgeColor: DEFAULT_REPO_BADGE_COLOR,
  addedAt: 1,
  kind: 'git'
}

const cachedProject: Repo = {
  ...project,
  repoIcon: {
    type: 'image',
    source: 'gitlab',
    label: 'engineering/forge',
    src: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAcElEQVR4AcXBAQ0CMQDAwNLMFZPBlGCDKcEGvsAB+Xwgvbvcro83IYlJTGISk5jEBgc8X3fOWnPzjcQkJrHBCWtufkViEpPY4ITn6843a26OkpjEJDY4Yc3Nr0hMYhKTmMQGB6y5+ReJSUxiEpOYxD6/5gu+HjgQaQAAAABJRU5ErkJggg=='
  }
}

function ProjectRow({ repo }: { repo: Repo }): React.JSX.Element {
  return (
    <div className="flex items-center gap-2 bg-sidebar p-3 text-[13px] text-sidebar-foreground">
      <RepoMark repo={repo} />
      <span>{repo.displayName}</span>
    </div>
  )
}

export const initials = defineFixture({
  width: 280,
  store: { repos: [project] },
  render: () => <ProjectRow repo={project} />
})

export const cachedAvatar = defineFixture({
  width: 280,
  store: { repos: [cachedProject] },
  render: () => <ProjectRow repo={cachedProject} />
})
