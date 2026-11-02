import { refreshLocalRuntimeCapabilities } from '@/runtime/local-runtime-capabilities'
import { ConfirmationDialogProvider } from '@/components/confirmation-dialog'
import type { PersistedUIState } from '../../../../shared/persisted-ui-state-types'
import { useRef } from 'react'
import { z } from 'zod'
import { defineFixture } from '../../component-fixtures/component-fixture'
import WorktreeList from './WorktreeList'
import SidebarWorkspaceOptionsMenu from './SidebarWorkspaceOptionsMenu'
import { useAppStore } from '@/store'
import { getDefaultUIState } from '../../../../shared/constants'
import { projectHostSetupProjectionFromRepos } from '../../../../shared/project-host-setup-projection'
import { mutatePersonalProjectOrder } from '../../../../shared/personal-project-order-writes'
import {
  RecordProjectOpenParams,
  SetProjectPinnedParams
} from '../../../../shared/rpc-contract/personal-project-order-params'
import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'
import type { VirtualizedScrollAnchor } from '@/hooks/useVirtualizedScrollAnchor'

const beta: Repo = {
  id: 'beta',
  path: '/fixture/beta',
  displayName: 'Beta',
  badgeColor: '',
  addedAt: 0,
  executionHostId: 'local'
}
const alpha: Repo = { ...beta, id: 'alpha', path: '/fixture/alpha', displayName: 'Alpha' }
const projection = projectHostSetupProjectionFromRepos([beta, alpha])
function workspace(repo: Repo, lastActivityAt: number): Worktree {
  return {
    id: `${repo.id}::${repo.path}`,
    repoId: repo.id,
    path: repo.path,
    displayName: 'main',
    branch: 'refs/heads/main',
    head: 'abc',
    isBare: false,
    isMainWorktree: true,
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt
  }
}
const betaWorkspace = workspace(beta, 5000)
const alphaWorkspace = workspace(alpha, 100)

function Sidebar() {
  const scrollOffsetRef = useRef(0)
  const scrollAnchorRef = useRef<VirtualizedScrollAnchor>(null)
  return (
    <ConfirmationDialogProvider>
      <div className="flex h-80 flex-col bg-sidebar text-sidebar-foreground">
        <div className="flex justify-end border-b border-sidebar-border p-2">
          <SidebarWorkspaceOptionsMenu />
        </div>
        <WorktreeList scrollOffsetRef={scrollOffsetRef} scrollAnchorRef={scrollAnchorRef} />
      </div>
    </ConfirmationDialogProvider>
  )
}

function fixture(personal: boolean, width = 360) {
  return defineFixture({
    width,
    store: {
      repos: [beta, alpha],
      projects: projection.projects,
      projectHostSetups: projection.setups,
      worktreesByRepo: { beta: [betaWorkspace], alpha: [alphaWorkspace] },
      groupBy: 'repo',
      sortBy: 'recent',
      projectOrderBy: 'recent',
      personalProjectOrder: personal
        ? {
            projects: {
              '["local","local","repo:alpha"]': { lastOpenedAt: 300, openCount: 1 },
              '["local","local","repo:beta"]': { lastOpenedAt: 100, openCount: 5 }
            },
            settledOperations: []
          }
        : undefined,
      showSleepingWorkspaces: true,
      collapsedGroups: new Set(),
      projectGroups: [],
      folderWorkspaces: []
    },
    setup: () => {
      let ui: PersistedUIState = {
        ...getDefaultUIState(),
        projectOrderBy: useAppStore.getState().projectOrderBy,
        personalProjectOrder: useAppStore.getState().personalProjectOrder
      }
      const runtime = {
        getUIState: () => ui,
        updateUIState: (patch: Partial<ReturnType<typeof getDefaultUIState>>) => {
          ui = { ...ui, ...patch }
          return ui
        }
      }
      window.api.runtime.getStatus = async () => ({
        runtimeId: 'fixture',
        rendererGraphEpoch: 0,
        graphStatus: 'ready',
        authoritativeWindowId: null,
        liveTabCount: 0,
        liveLeafCount: 0,
        runtimeProtocolVersion: 3,
        minCompatibleRuntimeClientVersion: 2,
        capabilities: personal ? ['ui.personalProjectOrder.v1'] : []
      })
      window.api.runtime.call = async (request) => {
        let result: unknown = { ui }
        if (request.method === 'status.get') {
          result = { capabilities: personal ? ['ui.personalProjectOrder.v1'] : [] }
        }
        if (request.method === 'ui.recordProjectOpen') {
          result = mutatePersonalProjectOrder(
            runtime,
            RecordProjectOpenParams.parse(request.params)
          )
        }
        if (request.method === 'ui.setProjectPinned') {
          result = mutatePersonalProjectOrder(runtime, SetProjectPinnedParams.parse(request.params))
        }
        if (request.method === 'ui.set') {
          const params = z
            .object({ projectOrderBy: z.enum(['manual', 'recent', 'frequent', 'name']) })
            .parse(request.params)
          ui = { ...ui, ...params }
          result = { ui }
        }
        return { id: 'fixture', ok: true, result, _meta: { runtimeId: 'fixture' } }
      }
      void refreshLocalRuntimeCapabilities()
    },
    render: () => <Sidebar />
  })
}

export const legacyRecent = fixture(false)
export const personalRecent = fixture(true)
export const narrowPersonalRecent = fixture(true, 300)

async function paint() {
  await new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  )
}
async function openMenu(label: string) {
  const trigger = document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)
  if (!trigger) {
    throw new Error(`Missing menu: ${label}`)
  }
  trigger.focus()
  trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
  await paint()
}
async function openProjectModes() {
  await openMenu('Workspace options')
  const trigger = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((entry) =>
    entry.textContent?.includes('Project order')
  )
  if (!trigger) {
    throw new Error('Missing Project order menu')
  }
  trigger.click()
  await paint()
}
export const projectModes = defineFixture({ ...fixture(true), interact: openProjectModes })
export const oldHostProjectModes = defineFixture({ ...fixture(false), interact: openProjectModes })
export const projectPinMenu = defineFixture({
  ...fixture(true),
  interact: () => openMenu('Project actions for Beta')
})
export const pinnedManual = defineFixture({
  ...fixture(true),
  store: { ...fixture(true).store, projectOrderBy: 'manual' },
  interact: async () => {
    await openMenu('Project actions for Alpha')
    const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((entry) =>
      entry.textContent?.includes('Pin project')
    )
    if (!item) {
      throw new Error('Missing Pin project action')
    }
    item.click()
    await paint()
    if (
      useAppStore.getState().personalProjectOrder?.projects['["local","local","repo:alpha"]']
        ?.pinned !== true
    ) {
      throw new Error('Pin did not acknowledge')
    }
    await openMenu('Project actions for Alpha')
  }
})

export const modeRoundTrip = defineFixture({
  ...fixture(true),
  store: { ...fixture(true).store, projectOrderBy: 'manual' },
  interact: async () => {
    const manualOrder = useAppStore
      .getState()
      .repos.map((repo) => repo.id)
      .join(',')
    await openProjectModes()
    for (const label of ['Name', 'Frequent', 'Recent', 'Manual']) {
      const item = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find(
        (entry) => entry.textContent?.trim() === label
      )
      if (!item || item.getAttribute('aria-disabled') === 'true') {
        throw new Error(`Unavailable mode: ${label}`)
      }
      item.click()
      await paint()
      if (item.getAttribute('aria-checked') !== 'true') {
        throw new Error(`Mode did not acknowledge: ${label}`)
      }
    }
    if (
      useAppStore
        .getState()
        .repos.map((repo) => repo.id)
        .join(',') !== manualOrder
    ) {
      throw new Error('Mode changes rewrote Manual')
    }
  }
})
