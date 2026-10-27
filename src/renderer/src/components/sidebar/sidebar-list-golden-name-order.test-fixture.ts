import type { Worktree } from '../../../../shared/worktree/types'
import type { AppState } from '@/store/types'
import { GOLDEN_NOW, folder, group, repo, wt } from './sidebar-list-golden-factories.test-fixture'

// Same visible text as "éclair", spelled as "e" plus a combining accent (NFD).
const ECLAIR_NFD = `e${String.fromCodePoint(0x301)}clair`

const eclairRepo = repo('r-eclair', 'Éclair', { projectGroupId: 'pg-eclair-accent' })
const angstromRepo = repo('r-angstrom', 'ångström', { projectGroupId: 'pg-angstrom-accent' })
const sshRepo = repo('r-ssh', 'eclair', { connectionId: 'gpu-vm' })

const recentTie = { lastActivityAt: GOLDEN_NOW - 1_000 }
const onSsh = { hostId: 'ssh:gpu-vm' } as const

const eclairWorktrees = [
  wt(eclairRepo, 'éclair'),
  wt(eclairRepo, 'Eclair'),
  wt(eclairRepo, 'eclair'),
  wt(eclairRepo, ECLAIR_NFD),
  wt(eclairRepo, 'zebra', recentTie),
  wt(eclairRepo, 'w10', recentTie),
  wt(eclairRepo, 'w2'),
  wt(eclairRepo, 'W2')
]
const angstromSame = wt(angstromRepo, 'angstrom', { lastActivityAt: GOLDEN_NOW - 5_000 })
const angstromSameOnSsh: Worktree = { ...angstromSame, ...onSsh }
const angstromWorktrees = [wt(angstromRepo, 'ångström'), angstromSame, angstromSameOnSsh]
const sshWorktrees = [wt(sshRepo, 'eclair', onSsh), wt(sshRepo, 'w2', onSsh)]

function folderGroup(id: string, name: string) {
  return group(id, name, { parentPath: `/folders/${id}`, createdFrom: 'folder-scan' })
}

/** Accented, mixed-case and numbered names everywhere the sidebar orders text. */
export function goldenNameOrderState(): Partial<AppState> {
  return {
    repos: [eclairRepo, angstromRepo, sshRepo],
    worktreesByRepo: {
      [eclairRepo.id]: eclairWorktrees,
      [angstromRepo.id]: angstromWorktrees,
      [sshRepo.id]: sshWorktrees
    },
    worktreeLineageById: {},
    endpointProjects: [],
    endpointProjectHostSetups: [],
    // Equal tabOrder everywhere, so group names decide the order.
    projectGroups: [
      folderGroup('pg-zebra', 'zebra'),
      group('pg-eclair-accent', 'Éclair'),
      group('pg-angstrom-accent', 'ångström'),
      folderGroup('pg-eclair', 'eclair'),
      folderGroup('pg-angstrom', 'angstrom')
    ],
    // Equal sortOrder everywhere, so folder names decide the order.
    folderWorkspaces: [
      folder('fw-zebra', 'pg-zebra', { name: 'zebra' }),
      folder('fw-w10', 'pg-zebra', { name: 'w10' }),
      folder('fw-w2-b', 'pg-zebra', { name: 'w2' }),
      folder('fw-w2-a', 'pg-zebra', { name: 'w2' }),
      folder('fw-W2', 'pg-zebra', { name: 'W2' }),
      folder('fw-eclair-accent', 'pg-zebra', { name: 'éclair' }),
      folder('fw-Eclair', 'pg-zebra', { name: 'Eclair' }),
      folder('fw-angstrom', 'pg-eclair', { name: 'angstrom' }),
      folder('fw-angstrom-accent', 'pg-eclair', { name: 'Ångström' }),
      folder('fw-eclair', 'pg-angstrom', { name: 'eclair' })
    ],
    prCache: {},
    detectedWorktreesByRepo: {},
    pendingWorktreeCreations: {}
  }
}
