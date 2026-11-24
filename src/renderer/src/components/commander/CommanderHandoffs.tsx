import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { CommanderMemoryPagination } from './CommanderMemoryPagination'
import { useCommanderMemoryIndex, useMemorySearch } from './use-commander-memory-index'
import { useAppStore } from '@/store/index'
import {
  createHandoffPageId,
  handoffPrompt,
  readHandoff
} from '../../../../shared/commander/goal-handoff'
import type {
  CommanderAccount,
  CommanderMemoryIndexQuery,
  CommanderMemoryRevision
} from '../../../../shared/commander/memory-contract'
import { CommanderHandoffDetail } from './CommanderHandoffDetail'
import { CommanderHandoffMetadata } from './CommanderHandoffMetadata'
import type { WorkerHandoffDestination } from './handoff-workspaces'
import { CommanderHandoffEditor } from './CommanderHandoffEditor'
import { selectedCommanderHost } from './selected-commander-host'

const loadWorkerHandoff = () => import('./resume-worker-handoff')
const loadCommanderChat = () => import('./open-commander-chat')

function currentAccount(account: CommanderAccount): boolean {
  const state = useAppStore.getState()
  const auth = state.orcaProfileAuthStatus
  return (
    !state.orcaProfileSwitching &&
    state.activeOrcaProfileId === account.profileId &&
    auth?.state === 'connected' &&
    auth.activeProfileId === account.profileId &&
    auth.cloud?.userId === account.userId &&
    (auth.cloud.activeOrgId ?? null) === account.activeOrgId
  )
}

type Props = { account: CommanderAccount; projectId: string | null; projectIds: readonly string[] }
type Selection = { pageId: string; page: CommanderMemoryRevision | null; editing: boolean }

export function CommanderHandoffs({ account, projectId, projectIds }: Props): React.JSX.Element {
  const t = useTranslate()
  const [scope, setScope] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const search = useMemorySearch(query)
  const filters = useMemo<CommanderMemoryIndexQuery>(
    () => ({
      validHandoffsOnly: true,
      order: 'recent',
      ...(scope ? { projectId: scope } : {}),
      ...(search ? { q: search } : {})
    }),
    [scope, search]
  )
  const [selected, setSelected] = useState<Selection | null>(null)
  const index = useCommanderMemoryIndex(account, filters, !selected)
  const projects = [
    ...new Set([
      ...index.projects,
      ...projectIds,
      ...(scope ? [scope] : []),
      ...(projectId ? [projectId] : [])
    ])
  ].sort()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const returnTo = useRef('')
  const list = useRef<HTMLElement>(null)
  const activation = useRef<symbol | null>(null)
  const locked = useRef(false)
  const isCurrent = useCallback(() => !!activation.current && currentAccount(account), [account])
  useEffect(() => {
    activation.current = Symbol()
    locked.current = false
    setBusy(false)
    return () => {
      activation.current = null
    }
  }, [])
  useEffect(() => {
    if (!selected && index.loaded && returnTo.current) {
      const target = list.current?.querySelector<HTMLButtonElement>(
        `[data-handoff-id="${returnTo.current}"]`
      )
      const control = target ?? list.current?.querySelector('input')
      control?.focus()
      returnTo.current = ''
    }
  }, [selected, index.loaded])

  async function open(
    page: Pick<CommanderMemoryRevision, 'pageId' | 'version'>,
    resume: boolean | WorkerHandoffDestination
  ): Promise<void> {
    if (locked.current) {
      return
    }
    locked.current = true
    setBusy(true)
    setError('')
    const ticket = activation.current
    const current = (): boolean => isCurrent() && activation.current === ticket
    async function openCurrent(): Promise<void> {
      const hostId =
        typeof resume === 'object' ? resume.hostId : resume ? selectedCommanderHost().hostId : null
      const destinationCurrent = (): boolean =>
        currentAccount(account) && hostId === selectedCommanderHost().hostId
      const { page: latest } = await window.api.commanderMemory.get(account, page.pageId, 1)
      if (!current()) {
        return
      }
      if (!readHandoff(latest)) {
        setSelected(null)
        setError(t('commander.handoffs.unavailable', 'This handoff is no longer available.'))
        if (!selected) {
          index.refresh()
        }
        return
      }
      returnTo.current = latest.pageId
      setSelected({ pageId: latest.pageId, page: latest, editing: false })
      if (!resume) {
        return
      }
      if (page.version !== latest.version) {
        setError(
          t(
            'commander.handoffs.changed',
            'This handoff changed. Review the latest version before opening chat.'
          )
        )
        return
      }
      if (typeof resume === 'object') {
        const { resumeWorkerHandoff } = await loadWorkerHandoff()
        if (
          current() &&
          !(await resumeWorkerHandoff(
            account,
            latest,
            resume,
            () => current() && destinationCurrent(),
            destinationCurrent
          )) &&
          current()
        ) {
          setError(
            t(
              'commander.handoffs.workerUnavailable',
              'Could not open this project chat. Check the workspace and agent on the selected host.'
            )
          )
        }
      } else {
        const chat = await loadCommanderChat()
        if (
          current() &&
          !(await chat.resumeCommanderHandoff(handoffPrompt(latest), destinationCurrent)) &&
          current()
        ) {
          setError(
            t(
              'commander.chatUnavailable',
              'The Commander workspace could not be opened. Try again.'
            )
          )
        }
      }
    }
    try {
      await openCurrent()
    } catch (reason) {
      if (current()) {
        setError(
          reason instanceof Error
            ? reason.message
            : t('commander.memory.readError', 'Could not load this page.')
        )
      }
    }
    if (activation.current === ticket) {
      locked.current = false
      setBusy(false)
    }
  }

  if (selected?.editing) {
    return (
      <CommanderHandoffEditor
        key={selected.pageId}
        account={account}
        pageId={selected.pageId}
        page={selected.page}
        projectId={scope ?? projectId}
        projectIds={projects}
        isCurrent={isCurrent}
        onCancel={() => setSelected(selected.page ? { ...selected, editing: false } : null)}
        onSaved={(page) => {
          setSelected({ pageId: page.pageId, page, editing: false })
        }}
      />
    )
  }
  const page = selected?.page
  const fields = page && readHandoff(page)
  if (page && fields) {
    return (
      <CommanderHandoffDetail
        account={account}
        page={page}
        fields={fields}
        busy={busy}
        error={error}
        onBack={() => {
          setSelected(null)
          setError('')
        }}
        onEdit={() => {
          setError('')
          setSelected({ pageId: page.pageId, page, editing: true })
        }}
        onRefresh={() => void open(page, false)}
        onResume={(target) => void open(page, target)}
      />
    )
  }
  return (
    <section ref={list} className="max-w-3xl space-y-3 px-4 py-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-medium">{t('commander.handoffs.saved', 'Saved handoffs')}</h2>
        <Button
          size="sm"
          data-handoff-id="new"
          disabled={busy}
          onClick={() => {
            returnTo.current = 'new'
            setError('')
            setSelected({ pageId: createHandoffPageId(), page: null, editing: true })
          }}
        >
          <Plus />
          {t('commander.handoffs.new', 'New handoff')}
        </Button>
      </div>
      <p className="text-muted-foreground">
        {t(
          'commander.handoffs.hint',
          'Save a goal to your account to continue it on another host.'
        )}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Select
          value={scope ? `id:${scope}` : 'all'}
          disabled={busy}
          onValueChange={(value) => {
            setScope(value === 'all' ? null : value.slice(3))
            setError('')
          }}
        >
          <SelectTrigger
            size="sm"
            className="max-w-full"
            aria-label={t('commander.project', 'Project')}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t('commander.memory.all', 'All projects')}</SelectItem>
            {projects.map((id) => (
              <SelectItem key={id} value={`id:${id}`}>
                {id}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input
          type="search"
          maxLength={512}
          className="min-w-32 flex-1"
          aria-label={t('commander.handoffs.search', 'Search handoffs')}
          placeholder={t('commander.handoffs.search', 'Search handoffs')}
          value={query}
          disabled={busy}
          onChange={(event) => {
            setQuery(event.target.value)
            setError('')
          }}
        />
      </div>
      {index.error && (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-2 break-words text-destructive"
        >
          {index.error}
          <Button size="xs" variant="outline" onClick={index.refresh}>
            {t('commander.memory.retry', 'Retry')}
          </Button>
        </div>
      )}
      {error && (
        <p role="alert" className="break-words text-destructive">
          {error}
        </p>
      )}
      {busy && (
        <p role="status" className="text-muted-foreground">
          {t('commander.memory.loadingPage', 'Loading page…')}
        </p>
      )}
      {!index.loaded && !index.error ? (
        <p role="status" className="text-muted-foreground">
          {t('commander.memory.loadingPages', 'Loading pages…')}
        </p>
      ) : (
        !index.error &&
        index.pages.length === 0 && (
          <p className="text-muted-foreground">
            {scope || search || index.previous
              ? t('commander.handoffs.noMatches', 'No matching handoffs.')
              : t('commander.handoffs.empty', 'No handoffs saved yet.')}
          </p>
        )
      )}
      <ul className="divide-y divide-border" aria-busy={index.pending || busy}>
        {index.pages.map((item) => (
          <li key={item.pageId}>
            <button
              data-handoff-id={item.pageId}
              type="button"
              disabled={busy}
              className="block w-full rounded-md px-2 py-3 text-left hover:bg-accent hover:text-accent-foreground focus-visible:outline-ring"
              onClick={() => void open(item, false)}
            >
              <span className="block break-words font-medium">{item.title}</span>
              <CommanderHandoffMetadata page={item} />
            </button>
          </li>
        ))}
      </ul>
      <CommanderMemoryPagination {...index} pending={index.pending || busy} />
    </section>
  )
}
