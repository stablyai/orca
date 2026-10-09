import { useEffect, useRef, useState } from 'react'
import { translate } from '@/i18n/i18n'
import type { Repo } from '../../../../../shared/repo-types'
import type { BacklogList, BacklogTask } from '../../../../../shared/backlog-types'
import { useAppStore } from '@/store'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import {
  backlogRepoKey,
  buildBacklogTaskPrompt,
  callBacklog,
  supportsBacklog
} from '@/lib/backlog-task-source'
import { buildExecutionHostRegistry } from '../../../../../shared/execution-host-registry'
import { getRepoExecutionHostId } from '../../../../../shared/execution-host'
import { getTaskPageRepoSourceContext } from '../../task-page-source-context'
import { BacklogTaskEditor } from './BacklogTaskEditor'

/** Selects supported repo or folder projects and remounts task state when host, repo, or path changes. */
export function BacklogTasks(): React.JSX.Element {
  const repos = useAppStore((state) => state.repos)
  const runtimeStatusByEnvironmentId = useAppStore((state) => state.runtimeStatusByEnvironmentId)
  const hosts = new Map(
    buildExecutionHostRegistry({ repos, settings: null, runtimeStatusByEnvironmentId }).map(
      (host) => [host.id, host]
    )
  )
  const supportedRepos = repos.filter((candidate) => supportsBacklog(candidate, hosts))
  const [selection, setSelection] = useState('')
  const repo =
    supportedRepos.find((candidate) => backlogRepoKey(candidate) === selection) ?? supportedRepos[0]
  return (
    <section className="mt-3 flex min-h-0 flex-1 flex-col gap-3">
      <Select value={repo ? backlogRepoKey(repo) : undefined} onValueChange={setSelection}>
        <SelectTrigger aria-label={translate('backlog.project', 'Backlog project')}>
          <SelectValue placeholder={translate('backlog.selectProject', 'Select a project')} />
        </SelectTrigger>
        <SelectContent>
          {supportedRepos.map((entry) => (
            <SelectItem key={backlogRepoKey(entry)} value={backlogRepoKey(entry)}>
              {entry.displayName} · {getRepoExecutionHostId(entry)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {repo ? (
        <BacklogProjectTasks key={backlogRepoKey(repo)} repo={repo} />
      ) : (
        <p className="text-sm text-muted-foreground">
          {repos.length
            ? translate(
                'backlog.unsupportedHost',
                'Update the project’s Orca server to use Backlog.md.'
              )
            : translate(
                'backlog.addProject',
                'Add a project or folder to browse Backlog.md tasks.'
              )}
        </p>
      )}
    </section>
  )
}

/** Browses one checkout; unconfirmed writes block editing until an explicit refresh succeeds. */
function BacklogProjectTasks({ repo }: { repo: Repo }): React.JSX.Element {
  const openModal = useAppStore((state) => state.openModal)
  const [list, setList] = useState<BacklogList | null>(null)
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState('')
  const [offset, setOffset] = useState(0)
  const [revision, setRevision] = useState(0)
  const [task, setTask] = useState<BacklogTask | null>(null)
  const [editing, setEditing] = useState(false)
  const [unconfirmed, setUnconfirmed] = useState(false)
  const unconfirmedRevision = useRef(-1)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const request = useRef(0)
  const hostId = getRepoExecutionHostId(repo)

  useEffect(() => {
    const ticket = ++request.current
    let active = true
    setLoading(true)
    setError(null)
    const timer = setTimeout(() => {
      void callBacklog(repo, { kind: 'list', search, status, offset })
        .then((reply) => {
          if (!active || request.current !== ticket) {
            return
          }
          if (!('tasks' in reply)) {
            throw new Error('Unexpected Backlog list response.')
          }
          setList(reply)
          if (revision > unconfirmedRevision.current) {
            setUnconfirmed(false)
          }
        })
        .catch((failure: unknown) => {
          if (active && request.current === ticket) {
            setList(null)
            setError(String(failure instanceof Error ? failure.message : failure))
          }
        })
        .finally(() => {
          if (active && request.current === ticket) {
            setLoading(false)
          }
        })
    }, 200)
    return () => {
      clearTimeout(timer)
      active = false
    }
  }, [repo, search, status, offset, revision])

  /** Applies detail responses only while their request ticket remains current. */
  async function readTask(id: string): Promise<void> {
    const ticket = ++request.current
    setLoading(true)
    setError(null)
    try {
      const reply = await callBacklog(repo, { kind: 'read', id })
      if (request.current !== ticket) {
        return
      }
      if (!('body' in reply)) {
        throw new Error('Unexpected Backlog task response.')
      }
      setTask(reply)
    } catch (failure) {
      if (request.current === ticket) {
        setError(failure instanceof Error ? failure.message : String(failure))
      }
    } finally {
      if (request.current === ticket) {
        setLoading(false)
      }
    }
  }

  /** Opens a source-bound composer draft after rechecking the host's advertised support. */
  function launch(): void {
    const state = useAppStore.getState()
    const hosts = new Map(
      buildExecutionHostRegistry({
        repos: state.repos,
        settings: null,
        runtimeStatusByEnvironmentId: state.runtimeStatusByEnvironmentId
      }).map((host) => [host.id, host])
    )
    if (!task || !supportsBacklog(repo, hosts)) {
      return
    }
    const context = getTaskPageRepoSourceContext(repo, 'backlog')
    if (!context) {
      return
    }
    openModal('new-workspace-composer', {
      initialRepoId: repo.id,
      prefilledName: `${task.id} ${task.title}`,
      taskSourceContext: context,
      backlogTaskPrompt: buildBacklogTaskPrompt(task, context),
      telemetrySource: 'sidebar'
    })
  }

  return (
    <>
      <p className="text-xs text-muted-foreground">
        {list?.projectName ?? repo.displayName} · {hostId} · {repo.path}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        {task ? (
          <>
            <Button variant="ghost" onClick={() => setTask(null)}>
              {translate('backlog.back', 'Back to tasks')}
            </Button>
            <Button onClick={launch} disabled={loading}>
              {translate('backlog.startWorkspace', 'Start workspace')}
            </Button>
            <Button
              variant="outline"
              disabled={loading || unconfirmed || Boolean(list?.mutationUnavailable)}
              onClick={() => setEditing(true)}
            >
              {translate('backlog.editTask', 'Edit task')}
            </Button>
          </>
        ) : (
          <>
            <Input
              aria-label={translate('backlog.searchLabel', 'Search Backlog tasks')}
              placeholder={translate('backlog.search', 'Search tasks')}
              value={search}
              onChange={(event) => {
                setSearch(event.target.value)
                setOffset(0)
              }}
            />
            <Select
              value={status ? `status:${status}` : 'all'}
              onValueChange={(value) => {
                setStatus(value === 'all' ? '' : value.slice('status:'.length))
                setOffset(0)
              }}
            >
              <SelectTrigger aria-label={translate('backlog.statusFilter', 'Backlog status')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">
                  {translate('backlog.allStatuses', 'All statuses')}
                </SelectItem>
                {list?.statuses.map((entry) => (
                  <SelectItem key={entry} value={`status:${entry}`}>
                    {entry}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              disabled={loading || unconfirmed || !list || Boolean(list.mutationUnavailable)}
              onClick={() => setEditing(true)}
            >
              {translate('backlog.newTask', 'New task')}
            </Button>
          </>
        )}
        <Button
          variant="outline"
          disabled={loading}
          onClick={() => {
            setTask(null)
            setRevision((value) => value + 1)
          }}
        >
          {translate('backlog.refresh', 'Refresh')}
        </Button>
      </div>
      {unconfirmed && !editing ? (
        <p role="alert" className="text-sm text-destructive">
          {translate(
            'backlog.unconfirmedSave',
            'Save completion is unconfirmed. Refresh and inspect tasks before trying again.'
          )}
        </p>
      ) : null}
      {list?.mutationUnavailable ? (
        <p role="status" className="text-xs text-muted-foreground">
          {list.mutationUnavailable}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {loading ? (
        <p role="status" className="text-sm text-muted-foreground">
          {translate('backlog.loading', 'Loading Backlog tasks…')}
        </p>
      ) : null}
      <div className="scrollbar-sleek min-h-0 flex-1 overflow-auto">
        {task ? (
          <article className="space-y-3">
            <h2 className="text-lg font-semibold">
              {task.id} · {task.title}
            </h2>
            <Badge variant="secondary">{task.status}</Badge>
            <pre className="whitespace-pre-wrap break-words font-sans text-sm">
              {task.body || translate('backlog.noDetails', 'No task details.')}
            </pre>
          </article>
        ) : (
          <>
            {!loading && list?.tasks.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {translate('backlog.noMatches', 'No matching tasks.')}
              </p>
            ) : null}
            {list?.tasks.map((entry) => (
              <Button
                key={entry.id}
                variant="ghost"
                className="w-full justify-start"
                disabled={loading}
                onClick={() => void readTask(entry.id)}
              >
                <span className="font-mono">{entry.id}</span>
                <span className="truncate">{entry.title}</span>
                <Badge variant="secondary">{entry.status}</Badge>
              </Button>
            ))}
          </>
        )}
      </div>
      {!task && list ? (
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            disabled={loading || offset === 0}
            onClick={() => setOffset(Math.max(0, offset - 100))}
          >
            {translate('backlog.previous', 'Previous')}
          </Button>
          <span className="text-xs text-muted-foreground">
            {translate('backlog.taskCount', '{{count}} tasks', { count: list.total })}
          </span>
          <Button
            variant="outline"
            disabled={loading || offset + 100 >= list.total}
            onClick={() => setOffset(offset + 100)}
          >
            {translate('backlog.next', 'Next')}
          </Button>
        </div>
      ) : null}
      {editing && list ? (
        <BacklogTaskEditor
          repo={repo}
          task={task}
          statuses={list.statuses}
          onClose={() => setEditing(false)}
          onUnconfirmed={() => {
            unconfirmedRevision.current = revision
            setUnconfirmed(true)
          }}
          onSaved={() => {
            setEditing(false)
            setTask(null)
            setRevision((value) => value + 1)
          }}
        />
      ) : null}
    </>
  )
}
