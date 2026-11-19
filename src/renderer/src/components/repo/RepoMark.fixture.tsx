import type { Repo } from '../../../../shared/repository/repo-types'
import { defineFixture } from '../../component-fixtures/component-fixture'
import { ProjectPeekHoverCard } from './project-peek/ProjectPeekHoverCard'
import { RepoMark } from './RepoMark'

function repo(id: string, addedAt: number, extra: Partial<Repo> = {}): Repo {
  return {
    id,
    path: `/Users/dev/code/${id}`,
    displayName: id,
    badgeColor: '#737373',
    repoIcon: null,
    addedAt,
    ...extra
  }
}

const sameOrcaEmoji = { type: 'emoji', emoji: '🐳' } as const
const REPOS: Repo[] = [
  repo('orca', 1, { repoIcon: sameOrcaEmoji }),
  repo('orca-internal', 2, { repoIcon: sameOrcaEmoji }),
  repo('dotfiles', 3),
  repo('scratch', 4),
  repo('api', 5, { repoIcon: { type: 'lucide', name: 'Braces' }, badgeColor: '#14b8a6' }),
  repo('site', 6, { repoIcon: { type: 'emoji', emoji: '🚀' } })
]

/** Shared emoji gets colored boxes; default folders get distinct auto colors; unique marks stay plain. */
export const disambiguated = defineFixture({
  width: 320,
  store: { repos: REPOS },
  render: () => (
    <div className="flex flex-col gap-2 p-3 text-xs">
      {REPOS.map((r) => (
        <div key={r.id} className="flex items-center gap-2">
          <RepoMark repo={r} />
          <span className="text-muted-foreground">{r.displayName}</span>
        </div>
      ))}
    </div>
  )
})

/** Hovering the mark opens the quick appearance editor. */
export const hoverEditor = defineFixture({
  width: 360,
  store: { repos: REPOS },
  render: () => (
    <div className="p-3">
      <ProjectPeekHoverCard repo={REPOS[1]}>
        <span tabIndex={0} data-testid="mark" className="inline-flex">
          <RepoMark repo={REPOS[1]} />
        </span>
      </ProjectPeekHoverCard>
    </div>
  ),
  interact: async (frame) => {
    frame.querySelector<HTMLElement>('[data-testid="mark"]')?.focus()
    await new Promise((resolve) => setTimeout(resolve, 700))
  }
})
