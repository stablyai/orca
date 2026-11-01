import { AUTOMATION_ORPHAN_ISSUES } from '../../../../shared/automation-list-scope'
import { AUTOMATION_CAPTURED_HOST_REFUSALS } from '../../../../shared/automation-owner-conflict'
import type { AutomationCapturedOwner } from './automation-captured-owner'
import { createElement } from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import type { Automation } from '../../../../shared/automations-types'
import type { AutomationOwnerRef } from '../../../../shared/automation-owner-ref'
import type { ProjectHostSetup } from '../../../../shared/project-types'
import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'
import type { AutomationListRow } from './automation-list-row-identity'
import { getDefaultSettings } from '../../../../shared/constants'
import type { AppState } from '@/store/types'
import {
  adoptEndpointRepo,
  adoptEndpointProjectHostSetup
} from '../../../../shared/endpoint-catalog-adoption'
import { withRepoHostOwnership } from '@/store/slices/worktrees/listing/worktree-host-ownership'
import { mergeFetchedReposForHost } from '@/store/repos/repo-catalog-identity'
import { getAutomationTargetAvailability } from './automation-target-availability'
import { createAutomationRunActions } from './automation-run-actions'
import { useAutomationsPageStoreState } from './use-automations-page-store-state'
import { AutomationListLocalRow } from './AutomationListLocalRow'
import { AutomationDetail } from './AutomationDetail'
import { TooltipProvider } from '@/components/ui/tooltip'

export function registerCapturedAutomationRunActionTests({
  actionMocks,
  makeAutomation,
  makeRepo,
  makeWorkspace,
  makeProjectHostSetup
}: {
  actionMocks: {
    rpc: ReturnType<typeof vi.fn>
    interaction: ReturnType<typeof vi.fn<AppState['recordFeatureInteraction']>>
    error: ReturnType<typeof vi.fn>
    state: Partial<AppState>
  }
  makeAutomation: (overrides?: Partial<Automation>) => Automation
  makeRepo: (overrides?: Partial<Repo>) => Repo
  makeWorkspace: (overrides?: Partial<Worktree>) => Worktree
  makeProjectHostSetup: (overrides?: Partial<ProjectHostSetup>) => ProjectHostSetup
}): void {
  it.each([
    ['local', false, false],
    ['local', true, false],
    ['ssh', false, false],
    ['ssh', true, false],
    ['ssh-offline', false, false],
    ['ssh-offline', true, false],
    ['reselection-connected', false, false],
    ['reselection-disconnected', false, false],
    ['reselection-connected', false, true],
    ['reselection-disconnected', false, true],
    ['runtime', false, false],
    ['runtime', true, false],
    ['runtime-ssh', false, false],
    ['runtime-ssh', true, false],
    ['runtime-ssh-offline', false, false],
    ['runtime-ssh-offline', true, false],
    ['ambiguous', false, false],
    ['ambiguous', true, false]
  ] as const)(
    'runs the canonical %s definition through its captured RPC with copied IDs, reversed=%s, enabled=%s',
    async (kind, reverse, enabled) => {
      vi.clearAllMocks()
      const isRuntime =
        kind === 'runtime' || kind === 'runtime-ssh' || kind === 'runtime-ssh-offline'
      const reselection = kind === 'reselection-connected' || kind === 'reselection-disconnected'
      const blocked =
        kind === 'ambiguous' ||
        kind === 'runtime-ssh-offline' ||
        kind === 'ssh-offline' ||
        reselection
      const blockedMessage = reselection
        ? AUTOMATION_CAPTURED_HOST_REFUSALS[AUTOMATION_ORPHAN_ISSUES.hostReselection]
        : kind === 'ambiguous'
          ? 'The target project is no longer available.'
          : 'Connect this SSH host before running manually.'
      const isSsh =
        kind === 'ssh' ||
        kind === 'ssh-offline' ||
        kind === 'runtime-ssh' ||
        kind === 'runtime-ssh-offline' ||
        reselection
      const host = isRuntime ? 'runtime:gpu' : isSsh ? 'ssh:box' : 'local'
      const owner: AutomationOwnerRef = {
        authority: isRuntime
          ? { kind: 'runtime', environmentId: 'gpu', pairingRevision: 4 }
          : { kind: 'desktop' },
        selector: isSsh ? { kind: 'ssh', targetId: 'box', targetGeneration: 7 } : { kind: 'self' }
      }
      const captured: AutomationCapturedOwner = reselection
        ? {
            owner: null,
            authority: owner.authority,
            selector: { kind: 'orphan', issue: AUTOMATION_ORPHAN_ISSUES.hostReselection }
          }
        : { owner, selector: owner.selector }
      const capturedOwners = new Map([[`row-${kind}`, captured]])
      const saved = makeAutomation({
        enabled,
        agentId: 'claude',
        executionTargetType: isSsh && !reselection ? 'ssh' : 'local',
        executionTargetId: isSsh && !reselection ? 'box' : 'local',
        runContext: {
          kind: 'workspace-run',
          projectId: 'project-1',
          projectHostSetupId: 'setup-1',
          repoId: 'repo-1',
          path: '/repo',
          hostId: isSsh ? 'ssh:box' : isRuntime ? 'local' : host
        }
      })
      const before = structuredClone(saved)
      if (kind === 'ambiguous') {
        saved.runContext = null
        before.runContext = null
      }
      const target = { kind: 'environment' as const, environmentId: 'gpu' }
      const runtimeRepos = ['local', 'ssh:box'].map((executionHostId) =>
        adoptEndpointRepo(
          target,
          makeRepo({
            executionHostId: executionHostId === 'local' ? 'local' : 'ssh:box',
            connectionId: executionHostId === 'local' ? null : 'box'
          })
        )
      )
      const repos = [
        ...['local', 'ssh:box'].map((executionHostId) =>
          makeRepo({
            executionHostId: executionHostId === 'local' ? 'local' : 'ssh:box'
          })
        ),
        ...mergeFetchedReposForHost([], runtimeRepos, 'runtime:gpu')
      ]
      const worktrees = [
        makeWorkspace({ hostId: 'local' }),
        makeWorkspace({ hostId: 'ssh:box' }),
        ...(['local', 'ssh:box'] as const).map((hostId) =>
          withRepoHostOwnership(makeWorkspace({ hostId }), 'runtime:gpu')
        )
      ]
      if (reverse) {
        repos.reverse()
        worktrees.reverse()
      }
      const row: AutomationListRow = {
        key: `row-${kind}`,
        automation: saved,
        hostLabel: kind,
        usageSummary: null,
        catalogRef: {
          authority:
            owner.authority.kind === 'runtime'
              ? { kind: 'runtime', environmentId: 'gpu' }
              : { kind: 'desktop' },
          selector: isSsh ? { kind: 'ssh', targetId: 'box' } : { kind: 'self' }
        }
      }
      // SAFETY: the store hook reads only these slice values; mutation/editor paths are not mounted.
      actionMocks.state = {
        repos,
        worktreesByRepo: { 'repo-1': worktrees },
        folderWorkspaces: [],
        wslMovedProjects: [],
        projectGroups: [],
        projects: [
          {
            id: 'project-1',
            displayName: 'Repo',
            badgeColor: 'blue',
            sourceRepoIds: ['repo-1'],
            createdAt: 1,
            updatedAt: 1
          }
        ],
        projectHostSetups: [
          makeProjectHostSetup({ hostId: 'local' }),
          makeProjectHostSetup({ hostId: 'ssh:box' }),
          ...(['local', 'ssh:box'] as const).map((hostId) =>
            adoptEndpointProjectHostSetup(
              target,
              makeProjectHostSetup({
                hostId,
                connectionId: hostId === 'local' ? null : 'box',
                executionHostId: hostId
              })
            )
          )
        ],
        sshConnectionStates: new Map(
          kind === 'runtime-ssh-offline'
            ? [['box', { targetId: 'box', status: 'connected', error: null, reconnectAttempt: 0 }]]
            : isRuntime
              ? reverse
                ? [
                    [
                      'box',
                      { targetId: 'box', status: 'auth-failed', error: null, reconnectAttempt: 0 }
                    ]
                  ]
                : []
              : [
                  [
                    'box',
                    {
                      targetId: 'box',
                      status:
                        kind === 'ssh-offline' || kind === 'reselection-disconnected'
                          ? 'disconnected'
                          : 'connected',
                      error: null,
                      reconnectAttempt: 0
                    }
                  ]
                ]
        ),
        sshStateByEnvironment: new Map([
          [
            'gpu',
            {
              targetsHydrated: true,
              targetLabels: new Map([['box', 'Server box']]),
              targetGenerations: new Map([['box', 7]]),
              removedTargetLabels: new Map(),
              connectionStates: new Map([
                [
                  'box',
                  {
                    targetId: 'box',
                    status: kind === 'runtime-ssh-offline' ? 'disconnected' : 'connected',
                    error: null,
                    reconnectAttempt: 0
                  }
                ]
              ])
            }
          ]
        ]),
        sshTargetLabels: new Map(),
        runtimeEnvironments: [],
        runtimeStatusByEnvironmentId: new Map(),
        settings: { ...getDefaultSettings('/tmp'), disabledTuiAgents: ['claude'] },
        recordFeatureInteraction: actionMocks.interaction
      } satisfies Partial<AppState>
      let store!: ReturnType<typeof useAutomationsPageStoreState>
      let runNow!: () => Promise<void>
      const hostTargetFor = () =>
        isRuntime
          ? { kind: 'environment' as const, environmentId: 'gpu' }
          : { kind: 'local' as const }
      const onRunNow = vi.fn(() => void runNow())
      function Controls() {
        store = useAutomationsPageStoreState()
        const repo = store.repoForRow(row)
        const workspace = store.worktreeForRow(row, repo)
        const availability = getAutomationTargetAvailability({
          automation: saved,
          capturedOwner: captured,
          repo,
          workspace,
          projectHostSetups: store.projectHostSetups,
          sshConnectionStates: store.sshConnectionStates,
          sshStateByEnvironment: store.sshStateByEnvironment,
          automationHostTarget: hostTargetFor()
        })
        return createElement(
          TooltipProvider,
          null,
          createElement(AutomationListLocalRow, {
            ...store,
            capturedOwners,
            row,
            selectedRowKey: row.key,
            isSelectedLocal: true,
            lastRunByAutomationId: new Map(),
            relativeNow: 1,
            hostTargetFor,
            automationSourceHostAvailabilityByRowKey: new Map(),
            onSelect: vi.fn(),
            onRunNow,
            onEdit: vi.fn(),
            onToggle: vi.fn(),
            onDelete: vi.fn()
          }),
          createElement(AutomationDetail, {
            automation: saved,
            runs: [],
            projectName: repo?.displayName ?? 'Missing',
            workspaceName: workspace?.displayName ?? 'Missing',
            projectDefaultBaseRef: null,
            runNowAvailability: availability,
            now: 1,
            onRunNow,
            onEdit: vi.fn(),
            onToggle: vi.fn(),
            onDelete: vi.fn()
          })
        )
      }
      const view = render(createElement(Controls))
      expect(store.repoForRow(row)?.executionHostId).toBe(kind === 'ambiguous' ? undefined : host)
      expect(store.worktreeForRow(row, store.repoForRow(row))?.hostId).toBe(
        kind === 'ambiguous' ? undefined : isRuntime && isSsh ? 'ssh:box' : host
      )
      actionMocks.rpc.mockResolvedValue({ run: { id: 'returned-run' } })
      const refresh = vi.fn(async () => undefined)
      // SAFETY: runNow reads these page members; editor and fallback transport are not installed.
      const actions = createAutomationRunActions({
        store,
        local: {
          rerunRunIdsInFlightRef: { current: new Set<string>() },
          setRerunRunIdsInFlight: vi.fn()
        },
        destination: {
          automationHostTargetFor: () =>
            isRuntime ? { kind: 'environment', environmentId: 'gpu' } : { kind: 'local' },
          automationDispatchContext: {
            authority: { kind: 'desktop' },
            capturedOwners
          },
          reportOwnerAction: vi.fn(),
          invalidateRowHost: vi.fn()
        },
        sourceAvailability: { automationSourceHostAvailabilityByRowKey: new Map() },
        pageRefresh: { hydratePersistedUIState: refresh, refresh }
      } satisfies Parameters<typeof createAutomationRunActions>[0])
      runNow = () => actions.runNow(row)
      const detailButton = screen.getByRole('button', { name: 'Run Now' })
      expect(detailButton.hasAttribute('disabled')).toBe(blocked)
      const user = userEvent.setup()
      await user.click(screen.getByRole('button', { name: 'Automation actions' }))
      const item = await screen.findByRole('menuitem', {
        name: blocked ? blockedMessage : 'Run Now'
      })
      expect(item.getAttribute('aria-disabled')).toBe(blocked ? 'true' : null)
      if (blocked) {
        const wrapper = screen.getByTitle(blockedMessage)
        expect(wrapper).toBe(item.parentElement)
        expect(wrapper.hasAttribute('disabled')).toBe(false)
        expect(wrapper.getAttribute('aria-disabled')).toBeNull()
        expect(wrapper.classList.contains('pointer-events-none')).toBe(false)
        await user.hover(wrapper)
        await user.click(wrapper)
        fireEvent.click(item)
        expect(onRunNow).not.toHaveBeenCalled()
        expect(actionMocks.rpc).not.toHaveBeenCalled()
        expect(actionMocks.interaction).not.toHaveBeenCalled()
      } else {
        expect(item.closest('[title]')).toBeNull()
      }
      await user.keyboard('{Escape}')
      const rowElement = view.container.querySelector('[data-automation-row-id]')
      if (!rowElement) {
        throw new Error('Automation list row is missing')
      }
      fireEvent.contextMenu(rowElement)
      const contextItem = await screen.findByRole('menuitem', {
        name: blocked ? blockedMessage : 'Run Now'
      })
      expect(contextItem.getAttribute('aria-disabled')).toBe(blocked ? 'true' : null)
      if (blocked) {
        const wrapper = screen.getByTitle(blockedMessage)
        expect(wrapper).toBe(contextItem.parentElement)
        expect(wrapper.hasAttribute('disabled')).toBe(false)
        expect(wrapper.getAttribute('aria-disabled')).toBeNull()
        expect(wrapper.classList.contains('pointer-events-none')).toBe(false)
        await user.hover(wrapper)
        await user.click(wrapper)
        fireEvent.click(contextItem)
        expect(onRunNow).not.toHaveBeenCalled()
        expect(actionMocks.rpc).not.toHaveBeenCalled()
        expect(actionMocks.interaction).not.toHaveBeenCalled()
      } else {
        expect(contextItem.closest('[title]')).toBeNull()
      }
      await user.keyboard('{Escape}')
      if (blocked) {
        await runNow()
      } else {
        await user.click(detailButton)
        await waitFor(() => expect(refresh).toHaveBeenCalledTimes(2))
      }
      if (blocked) {
        expect(actionMocks.error).toHaveBeenCalledWith(blockedMessage)
        expect(actionMocks.rpc).not.toHaveBeenCalled()
        expect(saved).toEqual(before)
        return
      }
      expect(actionMocks.error).not.toHaveBeenCalled()
      expect(actionMocks.rpc).toHaveBeenCalledOnce()
      expect(actionMocks.rpc).toHaveBeenCalledWith(
        isRuntime ? { kind: 'environment', environmentId: 'gpu' } : { kind: 'local' },
        'automation.runNow',
        {
          id: saved.id,
          expectedOwner: {
            selector: isSsh
              ? { kind: 'ssh', targetId: 'box', targetGeneration: 7 }
              : { kind: 'self' }
          }
        },
        expect.objectContaining(isRuntime ? { expectedEnvironmentPairingRevision: 4 } : {})
      )
      expect(refresh).toHaveBeenCalledTimes(2)
      expect(saved).toEqual(before)
    }
  )
}
