import type { GitGraphHistoryView } from './git-graph-history-view'
import { GitGraphCommitActionsController } from './git-graph-commit-actions-controller'
import { gitGraphOwnerKey, switchGitGraphWorkspace } from './git-graph-workspace-navigation'
import { createStore } from 'zustand/vanilla'
import { shallow } from 'zustand/shallow'
import { useAppStore } from '@/store'
import { gitGraphScope, gitGraphScopeInputs, GIT_GRAPH_REFRESH_EVENT } from '@/lib/git-graph-tab'
import { getRuntimeGitHistory } from '@/runtime/source-control/git/runtime-git-status-client'
import { translate } from '@/i18n/i18n'
import type {
  GitHistoryRefs,
  GitHistoryResult
} from '../../../../../shared/git/history/git-history-types'
import type { ExecutionHostId } from '../../../../../shared/execution-host'

const filterFor = (worktreeId: string) =>
  useAppStore.getState().gitGraphFiltersByWorktree?.[worktreeId] ?? 'all'

export class GitGraphHistoryController {
  readonly actions = new GitGraphCommitActionsController(this)
  get actionScope() {
    return this.scope
  }
  captureActionView(): () => boolean {
    const generation = this.generation
    const navigation = this.navigation
    return () => !this.disposed && generation === this.generation && navigation === this.navigation
  }
  readonly view = createStore<GitGraphHistoryView>(() => ({ loading: false }))
  scrollOffset = 0
  graphWidth = 132
  private scope: ReturnType<typeof gitGraphScope>
  private filter: GitHistoryRefs
  executionHostId: ExecutionHostId | undefined
  private navigation = 0
  private generation = 0
  private dirty = true
  private initial = true
  private visible = 0
  private disposed = false
  private pending?: Promise<GitHistoryResult | undefined>
  private unsubscribe?: () => void

  constructor(readonly worktreeId: string) {
    const state = useAppStore.getState()
    const file = state.openFiles.find((file) => file.id === `${worktreeId}::git-graph`)
    this.executionHostId =
      file?.operationProvenance?.generation.route.executionHostId ??
      gitGraphScope(worktreeId, state)?.route.executionHostId ??
      undefined
    this.scope = gitGraphScope(worktreeId, state, this.executionHostId)
    this.filter = filterFor(worktreeId)
  }

  attach(): () => void {
    this.visible++
    if (!this.unsubscribe) {
      this.unsubscribe = useAppStore.subscribe((state, previous) => {
        if (
          state.openFiles === previous.openFiles &&
          state.gitGraphFiltersByWorktree?.[this.worktreeId] ===
            previous.gitGraphFiltersByWorktree?.[this.worktreeId] &&
          shallow(gitGraphScopeInputs(state), gitGraphScopeInputs(previous))
        ) {
          return
        }
        this.synchronize()
      })
      window.addEventListener(GIT_GRAPH_REFRESH_EVENT, this.onRefresh)
    }
    this.synchronize()
    if (this.dirty) {
      void this.retrieve(false, this.initial)
    }
    return () => {
      this.visible--
    }
  }

  private synchronize(): void {
    const state = useAppStore.getState()
    const file = state.openFiles.find((file) => file.id === `${this.worktreeId}::git-graph`)
    this.executionHostId =
      file?.operationProvenance?.generation.route.executionHostId ?? this.executionHostId
    const scope = gitGraphScope(this.worktreeId, state, this.executionHostId)
    const filter = filterFor(this.worktreeId)
    if (
      gitGraphOwnerKey(scope) === gitGraphOwnerKey(this.scope) &&
      (filter === this.filter || JSON.stringify(filter) === JSON.stringify(this.filter))
    ) {
      return
    }
    this.actions.cancel()
    this.scope = scope
    this.filter = filter
    this.scrollOffset = 0
    this.view.setState({ loading: false }, true)
    this.invalidate()
  }

  private invalidate(): void {
    this.generation++
    this.pending = undefined
    this.dirty = true
    if (this.visible) {
      void this.retrieve(false, this.initial)
    }
  }

  private onRefresh = (event: Event): void => {
    if (event instanceof CustomEvent && event.detail === this.worktreeId) {
      this.invalidate()
    }
  }

  dispose(): void {
    this.actions.cancel()
    this.disposed = true
    this.generation++
    this.unsubscribe?.()
    window.removeEventListener(GIT_GRAPH_REFRESH_EVENT, this.onRefresh)
  }

  switchToWorkspace = (refId: string): Promise<void> => {
    const generation = this.generation
    return switchGitGraphWorkspace(
      this.scope,
      refId,
      () => !this.disposed && generation === this.generation
    )
  }

  select = (selectedId: string): void => {
    this.actions.cancel()
    this.navigation++
    this.view.setState({ selectedId, revealId: undefined })
  }
  clearReveal = (): void => {
    this.view.setState({ revealId: undefined })
  }
  refresh = (): Promise<GitHistoryResult | undefined> => {
    this.generation++
    this.pending = undefined
    return this.retrieve(false, true)
  }
  loadMore = (): Promise<GitHistoryResult | undefined> => this.retrieve(true)
  settledResult = (): Promise<GitHistoryResult | undefined> =>
    this.pending ?? (this.dirty ? this.retrieve() : Promise.resolve(this.view.getState().result))

  reveal = async (id: string): Promise<number> => {
    const generation = this.generation
    this.actions.cancel()
    const navigation = ++this.navigation
    this.clearReveal()
    const current = () =>
      !this.disposed && generation === this.generation && navigation === this.navigation
    while (this.pending && current()) {
      await this.pending
    }
    if (!current()) {
      return -1
    }
    let result = this.view.getState().result
    if (!result?.items.some((item) => item.id === id) && result?.hasMore) {
      result = await this.retrieve(true, false, id, navigation)
    }
    if (!current()) {
      return -1
    }
    const index = result?.items.findIndex((item) => item.id === id) ?? -1
    if (index !== -1) {
      this.view.setState({ selectedId: id, revealId: id })
    }
    return index
  }

  private retrieve(
    append = false,
    wakeWslDistro = false,
    revealId?: string,
    navigation?: number
  ): Promise<GitHistoryResult | undefined> {
    if (this.disposed) {
      return Promise.resolve(undefined)
    }
    if (this.pending) {
      return this.pending
    }
    const previous = this.view.getState().result
    const context = this.scope
    if (!context || (append && !previous?.hasMore)) {
      return Promise.resolve(context ? previous : undefined)
    }
    const generation = this.generation
    const targetDepth = previous?.items.length ?? 0
    const filter = this.filter
    const current = () => !this.disposed && generation === this.generation
    this.initial = false
    this.dirty = false
    this.view.setState({ loading: true, error: undefined })
    const run = async (): Promise<GitHistoryResult | undefined> => {
      let accumulated = append ? previous : undefined
      let items = [...(accumulated?.items ?? [])]
      let ids = new Set(items.map((item) => item.id))
      let recovered = false
      let error: string | undefined
      try {
        do {
          const page = await getRuntimeGitHistory(
            {
              target: context.target,
              worktreeId: this.worktreeId,
              worktreePath: context.worktree.path,
              connectionId: context.connectionId ?? undefined
            },
            {
              refs: filter,
              limit: 50,
              historyToken: accumulated?.historyToken,
              skip: items.length,
              wakeWslDistro
            }
          )
          if (!current()) {
            return undefined
          }
          if (page.historyChanged) {
            if (recovered) {
              throw new Error(
                translate(
                  'gitGraph.historyChanged',
                  'History changed again. Refresh the Git Graph to try again.'
                )
              )
            }
            recovered = true
            accumulated = undefined
            items = []
            ids = new Set()
            continue
          }
          const count = items.length
          for (const item of page.items) {
            if (!ids.has(item.id)) {
              ids.add(item.id)
              items.push(item)
            }
          }
          accumulated = { ...page, items }
          if (
            (!revealId &&
              items.length >= targetDepth &&
              (count >= targetDepth || ids.has(this.view.getState().selectedId ?? ''))) ||
            (revealId && (navigation !== this.navigation || ids.has(revealId))) ||
            !page.hasMore ||
            items.length === count
          ) {
            break
          }
        } while (current())
      } catch (cause) {
        error =
          cause instanceof Error
            ? cause.message
            : translate('gitGraph.loadFailed', 'Failed to load Git history')
      }
      if (!current()) {
        return undefined
      }
      const result = error !== undefined ? previous : (accumulated ?? previous)
      const selection = this.view.getState().selectedId
      const selectedId =
        result?.items.find((item) => item.id === selection)?.id ?? result?.items[0]?.id
      const selectionGone = selection !== undefined && selection !== selectedId
      if (selectionGone) {
        this.actions.cancel()
        this.scrollOffset = 0
      }
      this.view.setState({
        result,
        error,
        loading: false,
        selectedId,
        ...(selectionGone ? { revealId: selectedId } : {})
      })
      if (
        Array.isArray(filter) &&
        result?.resolvedRefs &&
        JSON.stringify(filter) !== JSON.stringify(result.resolvedRefs)
      ) {
        const refs = result.resolvedRefs
        useAppStore.setState((state) => ({
          gitGraphFiltersByWorktree: {
            ...state.gitGraphFiltersByWorktree,
            [this.worktreeId]: refs.length ? refs : 'head'
          }
        }))
      }
      return result
    }
    const pending = run().finally(() => {
      if (this.pending === pending) {
        this.pending = undefined
      }
    })
    this.pending = pending
    return pending
  }
}
