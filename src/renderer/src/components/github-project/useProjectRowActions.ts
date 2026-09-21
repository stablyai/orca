import { useCallback, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { useRepoSlugIndex } from '@/lib/repo-slug-index'
import { launchWorkItemDirect } from '@/lib/launch-work-item-direct'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { buildTaskSourceContextFromRepo } from '../../../../shared/task-source-context'
import { githubProjectHost } from '../../../../shared/github/project-identity'
import type { GitHubProjectRow, GitHubProjectTable } from '../../../../shared/github/project-types'
import type { GitHubWorkItem } from '../../../../shared/github/work-item-types'
import type { GitHubItemDialogProjectOrigin } from '@/components/GitHubItemDialog'
import {
  resolveMissingRepoProjectDialogState,
  resolveRepoBackedProjectDialogState
} from './project-dialog-state'
import { resolveSelectedProjectRowRepo } from './project-row-filtering'
import { buildProjectWorkItem } from './project-work-item'
import { useProjectRowMutations } from './useProjectRowMutations'

type DialogRepoItem = {
  workItem: GitHubWorkItem
  repoPath: string
  repoId: string
  origin: GitHubItemDialogProjectOrigin
}

export function useProjectRowActions({
  table,
  currentCacheKey,
  selectedRepoIds
}: {
  table: GitHubProjectTable | null
  currentCacheKey: string | null
  selectedRepoIds: ReadonlySet<string>
}) {
  const repos = useAppStore((state) => state.repos)
  const rowMutations = useProjectRowMutations(currentCacheKey)
  const { lookupSlug, lookupSlugMatches, ready: slugIndexReady } = useRepoSlugIndex()
  const [dialogRepoItem, setDialogRepoItem] = useState<DialogRepoItem | null>(null)
  const [slugDialog, setSlugDialog] = useState<{ origin: GitHubItemDialogProjectOrigin } | null>(
    null
  )
  const [repoNotInOrca, setRepoNotInOrca] = useState<{
    owner: string
    repo: string
    host?: string
    url: string | null
  } | null>(null)
  const liveRepoIds = useMemo(() => new Set(repos.map((repo) => repo.id)), [repos])
  const resolvedDialogRepoItem = resolveRepoBackedProjectDialogState(
    dialogRepoItem,
    liveRepoIds,
    selectedRepoIds
  )
  if (resolvedDialogRepoItem !== dialogRepoItem) {
    setDialogRepoItem(resolvedDialogRepoItem)
  }
  const dialogRepo = resolvedDialogRepoItem
    ? (repos.find((repo) => repo.id === resolvedDialogRepoItem.repoId) ?? null)
    : null
  const dialogSourceContext = dialogRepo
    ? buildTaskSourceContextFromRepo({
        provider: 'github',
        projectId: dialogRepo.id,
        repo: dialogRepo
      })
    : null
  const missingDialogs = resolveMissingRepoProjectDialogState({
    slugIndexReady,
    slugDialog,
    repoNotInOrca,
    lookupSlug,
    selectedRepoIds
  })
  if (missingDialogs.slugDialog !== slugDialog) {
    setSlugDialog(missingDialogs.slugDialog)
  }
  if (missingDialogs.repoNotInOrca !== repoNotInOrca) {
    setRepoNotInOrca(missingDialogs.repoNotInOrca)
  }

  const buildOrigin = useCallback(
    (row: GitHubProjectRow): GitHubItemDialogProjectOrigin | null => {
      if (!table || !currentCacheKey) {
        return null
      }
      if (row.itemType !== 'ISSUE' && row.itemType !== 'PULL_REQUEST') {
        return null
      }
      if (row.content.number == null || !row.content.repository) {
        return null
      }
      const [owner, repo] = row.content.repository.split('/')
      if (!owner || !repo) {
        return null
      }
      return {
        owner,
        repo,
        host: githubProjectHost(table.project.host),
        number: row.content.number,
        type: row.itemType === 'PULL_REQUEST' ? 'pr' : 'issue',
        projectId: table.project.id,
        projectItemId: row.id,
        cacheKey: currentCacheKey
      }
    },
    [currentCacheKey, table]
  )

  const resolveRow = useCallback(
    (row: GitHubProjectRow) => {
      if (!table) {
        return null
      }
      return resolveSelectedProjectRowRepo({
        row,
        lookupSlugMatches,
        host: table.project.host,
        slugIndexReady,
        selectedRepoIds
      })
    },
    [lookupSlugMatches, selectedRepoIds, slugIndexReady, table]
  )
  const openUrlWithMessage = useCallback((row: GitHubProjectRow, message: string) => {
    if (row.content.url) {
      void window.api.shell.openUrl(row.content.url)
    }
    toast.message(message)
  }, [])
  const messageForResolution = useCallback(
    (row: GitHubProjectRow, status: string): boolean => {
      const message =
        status === 'loading'
          ? translate(
              'auto.components.github.project.ProjectViewWrapper.f352abf7c3',
              'Repository list is updating.'
            )
          : status === 'unselected_match'
            ? translate(
                'auto.components.github.project.ProjectViewWrapper.1ce21b8cff',
                'This item is outside the selected repositories.'
              )
            : status === 'ambiguous_selected_match'
              ? translate(
                  'auto.components.github.project.ProjectViewWrapper.030de75bc5',
                  'This item matches multiple selected repositories.'
                )
              : null
      if (!message) {
        return false
      }
      openUrlWithMessage(row, message)
      return true
    },
    [openUrlWithMessage]
  )

  const openDialog = useCallback(
    (row: GitHubProjectRow) => {
      const origin = buildOrigin(row)
      if (!origin) {
        if (row.content.url) {
          void window.api.shell.openUrl(row.content.url)
        }
        return
      }
      const resolution = resolveRow(row)
      if (!resolution || messageForResolution(row, resolution.status)) {
        return
      }
      if (resolution.status === 'no_global_match') {
        setSlugDialog({ origin })
      } else if (resolution.status === 'selected_match' && table) {
        const workItem = buildProjectWorkItem(row, resolution.repo.id, table.project.host)
        if (workItem) {
          setDialogRepoItem({
            workItem,
            repoPath: resolution.repo.path,
            repoId: resolution.repo.id,
            origin
          })
        }
      }
    },
    [buildOrigin, messageForResolution, resolveRow, table]
  )

  const startWork = useCallback(
    (row: GitHubProjectRow) => {
      const origin = buildOrigin(row)
      const resolution = resolveRow(row)
      if (!origin || !resolution || messageForResolution(row, resolution.status)) {
        return
      }
      if (resolution.status === 'no_global_match') {
        setRepoNotInOrca({
          owner: origin.owner,
          repo: origin.repo,
          host: origin.host,
          url: row.content.url ?? null
        })
        return
      }
      if (resolution.status !== 'selected_match' || !table) {
        return
      }
      const workItem = buildProjectWorkItem(row, resolution.repo.id, table.project.host)
      if (!workItem) {
        return
      }
      // Why: issue #4756 changed only TaskPage's "Create workspace"; Project view stays on direct "start work now" launch.
      void launchWorkItemDirect({
        item: workItem,
        repoId: resolution.repo.id,
        launchSource: 'task_page',
        telemetrySource: 'sidebar',
        openModalFallback: () => {
          if (row.content.url) {
            void window.api.shell.openUrl(row.content.url)
          }
        }
      })
    },
    [buildOrigin, messageForResolution, resolveRow, table]
  )

  return {
    resolvedDialogRepoItem,
    dialogSourceContext,
    missingDialogs,
    setDialogRepoItem,
    setSlugDialog,
    setRepoNotInOrca,
    openDialog,
    startWork,
    ...rowMutations
  }
}
