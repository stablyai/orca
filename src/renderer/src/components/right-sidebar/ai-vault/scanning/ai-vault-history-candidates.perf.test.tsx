// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store/index'
import { useAllWorktrees } from '@/store/slices/worktrees/listing/use-worktree-catalog'
import { useRepos } from '@/store/repos/use-repository-catalog'
import {
  useAiVaultHistoryWorktrees,
  useAiVaultHistoryRecordWorktrees
} from '@/lib/agent-session/resume/history/ai-vault-history-candidates'
import { useAiVaultSessionWorktreeMap } from '../session-list/ai-vault-session-worktree'
import { applyDetectedWorktreeUpdates } from '@/store/slices/worktrees/listing/detected-worktree-meta'
import { selectDetectedWorktreesByRepo } from '@/store/workspaces/catalog/workspace-record-fields'
import { replaceDetectedWorktreeListing } from '@/store/slices/worktrees/listing/detected-worktree-publication'
import type { AiVaultSession } from '../../../../../../shared/ai-vault/contracts/ai-vault-types'
import {
  bare,
  bareId,
  checkout,
  repo,
  session,
  settings,
  publishStoppedHistoryListing
} from './ai-vault-history-only-resume.test-fixture'

vi.mock('../../../../../../shared/sidebar-inputs-switch', () => ({
  ORCA_SIDEBAR_INPUTS_IS_MAIN: false
}))
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({
  callRuntimeRpc: vi.fn(async () => undefined)
}))

afterEach(() => {
  cleanup()
  useAppStore.setState(useAppStore.getInitialState(), true)
})

it.each([100, 1000])(
  'keeps History matching and its mounted owner unchanged on irrelevant publications among %i candidates and records',
  (count) => {
    let candidateReads = 0
    let sessionReads = 0
    let renders = 0
    const visible = Array.from({ length: count }, (_, index) => ({
      ...checkout,
      get id() {
        candidateReads++
        return `repo-1::/repo/topic-${index}`
      },
      path: `/repo/topic-${index}`
    }))
    const original = {
      ...bare,
      get id() {
        candidateReads++
        return bareId
      }
    }
    const excluded = Array.from({ length: count }, (_, index) => ({
      ...bare,
      isBare: false,
      get id() {
        candidateReads++
        return `repo-1::/repo/excluded-${index}`
      },
      path: `/repo/excluded-${index}`
    }))
    const policyBare: typeof bare = {
      ...bare,
      id: 'repo-1::/policy/storage',
      path: '/policy/storage',
      ownership: 'agent-scratch',
      visibilitySource: { kind: 'built-in', id: 'claude' }
    }
    const historySettings: typeof settings = {
      ...settings,
      worktreeVisibilityDefaults: {
        external: 'show',
        sourcePreferences: { builtIn: { claude: 'hide' } }
      }
    }
    const sessions: AiVaultSession[] = Array.from({ length: count }, (_, index) => ({
      ...session(`record-${index}`, '/repo/.bare/src', `Record ${index}`),
      get cwd() {
        sessionReads++
        return '/repo/.bare/src'
      }
    }))
    useAppStore.setState(
      {
        ...useAppStore.getInitialState(),
        settings: historySettings,
        repos: [repo],
        worktreesByRepo: { [repo.id]: visible },
        detectedWorktreesByRepo: {
          [repo.id]: {
            repoId: repo.id,
            source: 'git',
            authoritative: true,
            worktrees: [original, policyBare, ...excluded]
          }
        }
      },
      true
    )
    const mounted = renderHook(
      ({ records }: { records: readonly AiVaultSession[] }) => {
        const repos = useRepos()
        const candidates = useAiVaultHistoryWorktrees(useAllWorktrees())
        const map = useAiVaultSessionWorktreeMap({
          sessions: records,
          repos,
          worktrees: candidates
        })
        renders++
        return { candidates, map }
      },
      { initialProps: { records: sessions } }
    )
    const initial = mounted.result.current
    expect(initial.map.get(sessions[0].id)).toMatchObject({
      worktreeId: bareId,
      label: bare.displayName
    })
    const warmRenders = renders
    candidateReads = 0
    sessionReads = 0
    act(() =>
      useAppStore.setState({
        settings: {
          ...historySettings,
          terminalFontSize: historySettings.terminalFontSize + 1,
          worktreeVisibilityDefaults: {
            ...historySettings.worktreeVisibilityDefaults,
            sourcePreferences: { builtIn: { claude: 'hide' } }
          }
        }
      })
    )
    expect(candidateReads).toBe(0)
    expect(sessionReads).toBe(0)
    expect(renders).toBe(warmRenders)
    expect(mounted.result.current).toBe(initial)

    const changed = applyDetectedWorktreeUpdates(
      selectDetectedWorktreesByRepo(useAppStore.getState()),
      'repo-1::/repo/excluded-0',
      { isUnread: true, lastActivityAt: 9 },
      'local'
    )
    // Count reader work after the real writer has prepared its addressed publication.
    candidateReads = 0
    act(() => useAppStore.setState({ detectedWorktreesByRepo: changed }))
    expect(candidateReads).toBe(0)
    expect(sessionReads).toBe(0)
    expect(renders).toBe(warmRenders)
    expect(mounted.result.current).toBe(initial)

    const bareAttention = applyDetectedWorktreeUpdates(
      selectDetectedWorktreesByRepo(useAppStore.getState()),
      bareId,
      { isUnread: true, lastActivityAt: 10 },
      'local'
    )
    candidateReads = 0
    act(() => useAppStore.setState({ detectedWorktreesByRepo: bareAttention }))
    expect(candidateReads).toBeLessThanOrEqual(2)
    expect(sessionReads).toBe(0)
    expect(renders).toBe(warmRenders)
    expect(mounted.result.current).toBe(initial)

    const renamed = applyDetectedWorktreeUpdates(
      selectDetectedWorktreesByRepo(useAppStore.getState()),
      bareId,
      { displayName: 'Renamed original' },
      'local'
    )
    candidateReads = 0
    act(() => useAppStore.setState({ detectedWorktreesByRepo: renamed }))
    expect(candidateReads).toBeGreaterThan(0)
    expect(sessionReads).toBeGreaterThan(0)
    expect(mounted.result.current.map).not.toBe(initial.map)
    expect(mounted.result.current.map.get(sessions[0].id)).toMatchObject({
      worktreeId: bareId,
      label: 'Renamed original'
    })
    expect(mounted.result.current.candidates.some((row) => row.id === policyBare.id)).toBe(false)
    act(() =>
      useAppStore.setState({
        settings: {
          ...historySettings,
          worktreeVisibilityDefaults: {
            ...historySettings.worktreeVisibilityDefaults,
            sourcePreferences: { builtIn: { claude: 'show' } }
          }
        }
      })
    )
    expect(mounted.result.current.candidates.some((row) => row.id === policyBare.id)).toBe(true)
    const renamedMap = mounted.result.current.map
    const added = session('new-record', '/repo/topic-0/src', 'New record')
    mounted.rerender({ records: [...sessions, added] })
    expect(mounted.result.current.map).not.toBe(renamedMap)
    expect(mounted.result.current.map.get(added.id)).toMatchObject({
      worktreeId: 'repo-1::/repo/topic-0'
    })
  }
)

it.each([100, 1000])(
  'keeps closed-record matching current through stopped metadata and ignores attention/foreign writes among %i rows',
  (count) => {
    let candidateReads = 0
    let sessionReads = 0
    let renders = 0
    const records: AiVaultSession[] = Array.from({ length: count }, (_, index) => ({
      ...session(`closed-${index}`, '/repo/.bare/src', `Closed ${index}`),
      get cwd() {
        sessionReads++
        return '/repo/.bare/src'
      }
    }))
    const foreign = Array.from({ length: count }, (_, index) => ({
      ...bare,
      isBare: false,
      id: `repo-1::/foreign/${index}`,
      hostId: 'runtime:other' as const,
      get path() {
        candidateReads++
        return `/foreign/${index}`
      }
    }))
    useAppStore.setState(
      {
        ...useAppStore.getInitialState(),
        settings,
        repos: [repo],
        worktreesByRepo: { [repo.id]: [checkout] },
        detectedWorktreesByRepo: {
          [repo.id]: {
            repoId: repo.id,
            source: 'git',
            authoritative: true,
            worktrees: [bare, ...foreign]
          }
        }
      },
      true
    )
    const mounted = renderHook(
      ({ records }: { records: readonly AiVaultSession[] }) => {
        const visible = useAllWorktrees()
        const scoped = useAiVaultHistoryWorktrees(visible)
        const candidates = useAiVaultHistoryRecordWorktrees(visible, records)
        const map = useAiVaultSessionWorktreeMap({
          sessions: records,
          repos: useRepos(),
          worktrees: candidates
        })
        renders++
        return { scoped, candidates, map }
      },
      { initialProps: { records } }
    )
    expect(mounted.result.current.map.get(records[0].id)?.worktreeId).toBe(bareId)
    act(() => publishStoppedHistoryListing())
    expect(mounted.result.current.scoped).toEqual([checkout])
    expect(mounted.result.current.map.get(records[0].id)?.worktreeId).toBe(bareId)
    const warm = mounted.result.current
    const warmRenders = renders
    const attention = applyDetectedWorktreeUpdates(
      selectDetectedWorktreesByRepo(useAppStore.getState()),
      bareId,
      { isUnread: true },
      'local'
    )
    candidateReads = 0
    sessionReads = 0
    act(() => useAppStore.setState({ detectedWorktreesByRepo: attention }))
    expect(candidateReads).toBe(0)
    expect(sessionReads).toBe(0)
    expect(renders).toBe(warmRenders)
    expect(mounted.result.current).toBe(warm)
    const otherHost = applyDetectedWorktreeUpdates(
      selectDetectedWorktreesByRepo(useAppStore.getState()),
      'repo-1::/foreign/0',
      { displayName: 'Other host changed' },
      'runtime:other'
    )
    candidateReads = 0
    act(() => useAppStore.setState({ detectedWorktreesByRepo: otherHost }))
    expect(candidateReads).toBe(0)
    expect(sessionReads).toBe(0)
    expect(renders).toBe(warmRenders)
    expect(mounted.result.current).toBe(warm)
    act(() =>
      useAppStore.setState({
        settings: { ...settings, terminalFontSize: settings.terminalFontSize + 1 }
      })
    )
    expect(candidateReads).toBe(0)
    expect(sessionReads).toBe(0)
    expect(renders).toBe(warmRenders)
    const detected = selectDetectedWorktreesByRepo(useAppStore.getState())
    const listing = detected[repo.id]
    const changed = replaceDetectedWorktreeListing(detected, repo.id, {
      ...listing,
      worktrees: listing.worktrees.map((row) =>
        row.id === bareId && row.hostId === 'local'
          ? {
              ...row,
              path: '/relocated/storage',
              displayName: 'Current metadata',
              priorWorktreeIds: [bareId]
            }
          : row
      )
    })
    act(() => useAppStore.setState({ detectedWorktreesByRepo: changed }))
    expect(sessionReads).toBeGreaterThan(0)
    expect(mounted.result.current.map).not.toBe(warm.map)
    expect(mounted.result.current.map.get(records[0].id)).toMatchObject({
      worktreeId: bareId,
      path: '/repo/.bare',
      label: 'Current metadata'
    })
    act(() =>
      useAppStore.setState((state) => ({
        detectedWorktreesByRepo: applyDetectedWorktreeUpdates(
          selectDetectedWorktreesByRepo(state),
          bareId,
          { hostId: 'runtime:other' },
          'local'
        )
      }))
    )
    expect(mounted.result.current.map.get(records[0].id)?.worktreeId).toBeUndefined()
    const added = session('another-record', '/repo/checkout/src', 'Another record')
    mounted.rerender({ records: [...records, added] })
    expect(mounted.result.current.map.get(added.id)?.worktreeId).toBe(checkout.id)
  }
)
