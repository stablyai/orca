import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  closeTestStores,
  testState,
  createStore,
  writeDataFile,
  makeRepo
} from '../../src/main/persistence/persistence-test-harness'
import { getDefaultPersistedState } from '../../src/shared/constants'
import { OrcaRuntimeService } from '../../src/main/runtime/orca-runtime'
import { resolveAutomationRunTarget } from '../../src/main/automations/run-target-resolution'
import { buildHeadlessAutomationWorktreeCreateArgs } from '../../src/main/automations/headless-workspace-create'
import { makeWorktree } from '../../src/renderer/src/components/automations/automations-page-fixtures'

vi.mock('../../src/main/ssh/config/ssh-config-parser', () => ({
  loadUserSshConfig: () => ({ hosts: [] }),
  sshConfigHostsToTargets: () => []
}))
vi.mock('../../src/main/telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../src/main/telemetry/cohort-classifier', () => ({
  getCohortAtEmit: () => ({ nth_repo_added: 2 })
}))

beforeEach(() => {
  testState.dir = mkdtempSync(join(tmpdir(), 'orca-target-dispatch-'))
})
afterEach(async () => {
  await closeTestStores()
  rmSync(testState.dir, { recursive: true, force: true })
})

describe('persisted automation target dispatch', () => {
  it.each([false, true])(
    'retains copied local and SSH targets through runtime writes, reload and dispatch, reversed=%s',
    async (reverse) => {
      const repos = [
        makeRepo({ executionHostId: 'local', path: '/same/path' }),
        makeRepo({ executionHostId: 'ssh:box', connectionId: 'box', path: '/same/path' })
      ]
      writeDataFile({
        ...getDefaultPersistedState(testState.dir),
        repos: reverse ? repos.toReversed() : repos,
        sshTargets: [
          {
            id: 'box',
            label: 'Box',
            host: 'example.test',
            username: 'test',
            port: 22,
            generation: 7
          }
        ]
      })
      const store = await createStore()
      const runtime = new OrcaRuntimeService(store)
      const ids: string[] = []
      for (const hostId of ['local', 'ssh:box'] as const) {
        const setup = store
          .getProjectHostSetups()
          .find((row) => row.repoId === 'r1' && row.hostId === hostId)!
        expect(setup).toBeDefined()
        const created = await runtime.createAutomation({
          name: hostId,
          prompt: 'Run checks',
          agentId: 'codex',
          repo: 'id:r1',
          workspaceMode: 'new_per_run',
          timezone: 'UTC',
          rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
          dtstart: 1,
          runContext: {
            kind: 'workspace-run',
            projectId: setup.projectId,
            projectHostSetupId: setup.id,
            hostId,
            repoId: 'r1',
            path: '/same/path'
          }
        })
        ids.push(created.id)
        const owner = store.automationOwnerPrecondition(created.id)!
        const edited = await runtime.updateAutomation(
          created.id,
          { name: `${hostId} edited` },
          { expectedOwner: owner }
        )
        expect(edited.runContext).toMatchObject({ hostId, repoId: 'r1', path: '/same/path' })
        expect(edited.executionTargetId).toBe(hostId === 'local' ? 'local' : 'box')
      }
      await store.flushPendingOrThrowAsync()
      const reloaded = await createStore()
      const { useAppStore } = await import('../../src/renderer/src/store')
      const { resolveAutomationDispatchWorkspace, prepareAutomationDispatchWorkspace } =
        await import('../../src/renderer/src/hooks/automation-dispatch-workspace')
      const previous = useAppStore.getState()
      const previousWindow = globalThis.window
      try {
        vi.stubGlobal('window', {
          api: {
            ssh: {
              needsPassphrasePrompt: vi.fn(async () => false),
              getState: vi.fn(async () => ({ status: 'connected' }))
            }
          }
        })
        for (const [index, hostId] of (['local', 'ssh:box'] as const).entries()) {
          const saved = reloaded.listAutomations().find((row) => row.id === ids[index])!
          const selector = reloaded
            .listAutomationsForScope()
            .items.find((row) => row.automationId === saved.id)?.selector
          expect(selector).toEqual(
            hostId === 'local'
              ? { kind: 'self' }
              : { kind: 'ssh', targetId: 'box', targetGeneration: 7 }
          )
          const resolvedTarget = resolveAutomationRunTarget(reloaded, saved)
          expect(resolvedTarget.ok).toBe(true)
          if (!resolvedTarget.ok) {
            throw new Error(resolvedTarget.error)
          }
          expect(resolvedTarget.repo.executionHostId).toBe(hostId)
          const run = reloaded.createAutomationRun(saved, 1, 'manual')
          expect(
            buildHeadlessAutomationWorktreeCreateArgs({
              automation: saved,
              repo: resolvedTarget.repo,
              run
            }).repoSelector
          ).toEqual({ selector: 'id:r1', hostId })
          const createdWorktree = makeWorktree({
            id: `created-${index}`,
            repoId: 'r1',
            path: '/new/workspace',
            hostId,
            displayName: saved.name
          })
          const createWorktree = vi.fn<typeof previous.createWorktree>().mockResolvedValue({
            worktree: createdWorktree
          })
          useAppStore.setState({
            repos: reloaded.getRepos(),
            createWorktree
          })
          const state = useAppStore.getState()
          const resolved = resolveAutomationDispatchWorkspace(state, saved, run)
          expect(resolved.repo?.executionHostId).toBe(hostId)
          if (!resolved.repo) {
            throw new Error('Missing dispatch repo')
          }
          const result = await prepareAutomationDispatchWorkspace({
            state,
            automation: saved,
            run,
            dispatchToken: 'claim',
            resolved: { ...resolved, repo: resolved.repo },
            markDispatchResult: vi.fn()
          })
          expect(result?.hostId).toBe(hostId)
          expect(createWorktree.mock.calls[0]?.at(-1)).toMatchObject({ executionHostId: hostId })
        }
      } finally {
        useAppStore.setState(previous, true)
        vi.stubGlobal('window', previousWindow)
      }
    }
  )
})
