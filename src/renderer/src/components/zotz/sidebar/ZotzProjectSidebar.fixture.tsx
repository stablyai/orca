import { defineFixture } from '../../../component-fixtures/component-fixture'
import type { Repo } from '../../../../../shared/repository/repo-types'
import type { PublicKnownRuntimeEnvironment } from '../../../../../shared/remote-runtime/host-catalog/runtime-environments'
import type { Worktree } from '../../../../../shared/worktree/types'
import { EMPTY_ZOTZ_AGENT_QUEUE_SNAPSHOT } from '../../../../../shared/zotz/agent-queue/zotz-agent-queue-snapshot'
import ZotzProjectSidebar from './ZotzProjectSidebar'
import { ZotzConversationRow } from './ZotzConversationRow'

function repo(id: string, displayName: string): Repo {
  return { id, path: `/code/${id}`, displayName, badgeColor: '', addedAt: 1 }
}

function worktree(
  repoId: string,
  branch: string,
  displayName: string,
  extra: Partial<Worktree> = {}
): Worktree {
  return {
    id: `${repoId}::${branch}`,
    displayName,
    repoId,
    path: `/code/${repoId}/${branch}`,
    branch: `refs/heads/${branch}`,
    head: 'abc1234',
    isBare: false,
    isMainWorktree: false,
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 1,
    ...extra
  }
}

const zotz = repo('zotz', 'zotz')
const panel = repo('panel', 'avena.io-panel')
const backend = repo('backend', 'backend')

export const projects = defineFixture({
  width: 300,
  store: {
    repos: [zotz, panel, backend],
    worktreesByRepo: {
      zotz: [
        worktree('zotz', 'main', 'main', { isMainWorktree: true }),
        worktree('zotz', 'isai-avena/zotz-mejorar-vistas', 'Mejorar vistas', { lastActivityAt: 3 }),
        worktree('zotz', 'zotz/fase-1b-sin-orca', 'Desconectar servidores de Orca', {
          lastActivityAt: 2
        }),
        worktree('zotz', 'cli-made', 'Created by the CLI', {
          cliProvenance: { kind: 'created-by-cli', createdAt: 1 }
        })
      ],
      panel: [
        worktree('panel', 'master', 'master', { isMainWorktree: true }),
        worktree('panel', 'op-142-fix-login', 'OP-142 login con Google')
      ],
      backend: [worktree('backend', 'main', 'main', { isMainWorktree: true })]
    },
    activeWorktreeId: 'zotz::isai-avena/zotz-mejorar-vistas'
  },
  render: () => (
    <div className="flex h-[520px] flex-col bg-worktree-sidebar">
      <ZotzProjectSidebar />
    </div>
  )
})

const msiRuntime: PublicKnownRuntimeEnvironment = {
  id: 'msi',
  name: 'MSI',
  source: 'manual',
  createdAt: 1,
  updatedAt: 1,
  lastUsedAt: null,
  runtimeId: null,
  preferredEndpointId: 'default',
  endpoints: []
}
const rodri: Repo = { ...repo('rodri', 'rodri'), executionHostId: 'runtime:msi' }
const uni: Repo = { ...repo('uni', 'uni'), executionHostId: 'runtime:msi' }

export const remoteProjects = defineFixture({
  width: 300,
  setup: () => {
    Object.assign(window.api, {
      zotzAgentQueue: {
        onChanged: () => () => {},
        snapshot: async () => EMPTY_ZOTZ_AGENT_QUEUE_SNAPSHOT
      }
    })
  },
  store: {
    repos: [zotz, rodri, uni],
    runtimeEnvironments: [msiRuntime],
    worktreesByRepo: {
      zotz: [worktree('zotz', 'main', 'main', { isMainWorktree: true })],
      rodri: [worktree('rodri', 'main', 'rodri', { isMainWorktree: true })],
      uni: [worktree('uni', 'main', 'uni', { isMainWorktree: true })]
    }
  },
  render: () => (
    <div className="flex h-[260px] flex-col bg-worktree-sidebar">
      <ZotzProjectSidebar />
    </div>
  )
})

const queuedWorktree = worktree('zotz', 'memory-limiter', 'Indicador de la cola')

export const queuedConversation = defineFixture({
  width: 300,
  store: { repos: [zotz], worktreesByRepo: { zotz: [queuedWorktree] } },
  render: () => (
    <div className="bg-worktree-sidebar p-2">
      <ZotzConversationRow
        row={{
          id: queuedWorktree.id,
          worktree: queuedWorktree,
          title: 'Indicador de la cola',
          branch: 'memory-limiter',
          lastActivityAt: 1
        }}
        repo={zotz}
        active={false}
        status={{ state: 'working', unread: false }}
        canceled={false}
        queuedSince={Date.now() - 20 * 60_000}
      />
    </div>
  )
})
