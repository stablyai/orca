import { useMemo, useState } from 'react'
import { useCommanderMemoryIndex, useMemorySearch } from './use-commander-memory-index'
import { CommanderMemoryPagination } from './CommanderMemoryPagination'
import { BookOpen, Plus } from 'lucide-react'
import { createNonSecureContextUuid as createBrowserUuid } from '../../../../shared/identifiers/non-secure-context-uuid'
import { memoryKind, memoryActor } from './commander-memory-labels'
import { useTranslate } from '@/i18n/use-translate'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { CommanderMemoryGrant } from './CommanderMemoryGrant'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Checkbox } from '@/components/ui/checkbox'
import {
  OrcaSignInButton,
  OrcaSignInWaitNotice
} from '@/components/orca-profiles/OrcaSignInProgress'
import { useOrcaProfileAuthStatusRefresh } from '@/components/orca-profiles/use-orca-profile-auth-status-refresh'
import { useAppStore } from '@/store/index'
import type {
  CommanderAccount,
  CommanderMemorySummary,
  CommanderMemoryIndexQuery
} from '../../../../shared/commander/memory-contract'
import { CommanderPhoneSharing } from './CommanderPhoneSharing'
import { CommanderRecurringAnswersSwitch } from './CommanderRecurringAnswersSwitch'
import { CommanderRecoveryRecording } from './CommanderRecoveryRecording'
import { CommanderRecording } from './CommanderRecording'
import { CommanderHandoffs } from './CommanderHandoffs'
import { CommanderMemoryPage } from './CommanderMemoryPage'

type OpenPage = { pageId: string; projectId: string | null; isNew: boolean; recurring?: boolean }

type MemoryScopeProps = {
  projectId: string | null
  view?: 'handoffs'
  projectIds?: readonly string[]
  onClearProject?: () => void
}

export function CommanderMemory(scopeProps: MemoryScopeProps): React.JSX.Element {
  const t = useTranslate()
  useOrcaProfileAuthStatusRefresh()
  const auth = useAppStore((state) => state.orcaProfileAuthStatus)
  const switching = useAppStore((state) => state.orcaProfileSwitching)
  const profileId = useAppStore((state) => state.activeOrcaProfileId)
  const userId =
    auth?.state === 'connected' && auth.activeProfileId === profileId ? auth.cloud?.userId : null
  const activeOrgId = auth?.cloud?.activeOrgId ?? null
  const account = useMemo(
    () => (profileId && userId ? { profileId, userId, activeOrgId } : null),
    [profileId, userId, activeOrgId]
  )
  if (!auth || switching) {
    return (
      <p className="p-4 text-sm text-muted-foreground" role="status">
        {t('commander.memory.checking', 'Checking Orca account…')}
      </p>
    )
  }
  if (!account) {
    return (
      <section className="space-y-3 p-4">
        <p className="text-sm">
          {scopeProps.view === 'handoffs'
            ? t(
                'commander.handoffs.signIn',
                'Sign in to save goals and resume them on another host.'
              )
            : t(
                'commander.memory.requireSignIn',
                'Sign in to read and edit your Commander memory.'
              )}
        </p>
        <OrcaSignInButton size="sm" disabled={!auth.configured}>
          {t('commander.memory.signIn', 'Sign in to Orca')}
        </OrcaSignInButton>
        <OrcaSignInWaitNotice />
      </section>
    )
  }
  if (!window.api.commanderMemory) {
    return (
      <p className="p-4 text-sm text-muted-foreground">
        {t('commander.memory.desktop', 'Open Orca Desktop to use Commander memory.')}
      </p>
    )
  }
  if (scopeProps.view === 'handoffs') {
    return (
      <CommanderHandoffs
        key={JSON.stringify([account.profileId, account.userId, account.activeOrgId])}
        account={account}
        projectId={scopeProps.projectId}
        projectIds={scopeProps.projectIds ?? []}
      />
    )
  }
  return (
    <AccountMemory
      key={JSON.stringify([account.profileId, account.userId, account.activeOrgId])}
      account={account}
      {...scopeProps}
    />
  )
}

function AccountMemory({
  account,
  projectId,
  projectIds,
  onClearProject
}: MemoryScopeProps & { account: CommanderAccount }): React.JSX.Element {
  const t = useTranslate()
  const [storedProject, setStoredProject] = useState<string | null>(null)
  const scope = projectId ?? storedProject
  const [query, setQuery] = useState('')
  const [view, setView] = useState('all')
  const [deleted, setDeleted] = useState(false)
  const [selected, setSelected] = useState<OpenPage | null>(null)
  const search = useMemorySearch(query)
  const filters = useMemo<CommanderMemoryIndexQuery>(
    () => ({
      order: 'recent',
      includeDeletedProjects: true,
      ...(search ? { q: search } : {}),
      ...(scope ? { projectId: scope } : {}),
      ...(deleted ? { includeDeleted: true } : {}),
      ...(view === 'decisions' ? { kind: 'decision' } : {}),
      ...(view === 'rules' ? { recurringOnly: true } : {})
    }),
    [search, scope, deleted, view]
  )
  const index = useCommanderMemoryIndex(account, filters, !selected)
  const { pages, error, loaded } = index
  const projects = [
    ...new Set([...(scope ? [scope] : []), ...(projectIds ?? []), ...index.projects])
  ].sort()
  const openPage = (page: Pick<CommanderMemorySummary, 'pageId' | 'projectId'>): void => {
    setSelected({ pageId: page.pageId, projectId: page.projectId ?? null, isNew: false })
  }
  if (selected) {
    return (
      <CommanderMemoryPage
        key={selected.pageId}
        account={account}
        selected={selected}
        projects={projects}
        pages={pages}
        onBack={() => setSelected(null)}
        onOpen={openPage}
      />
    )
  }
  return (
    <section className="space-y-4 px-4 py-3">
      <CommanderRecurringAnswersSwitch account={account} />
      {typeof window.api.commanderMemory.agentRecovery === 'function' && (
        <CommanderRecoveryRecording account={account} />
      )}
      <CommanderRecording account={account} />
      <CommanderPhoneSharing account={account} />
      <Select
        value={scope ? `id:${scope}` : 'all'}
        onValueChange={(value) => {
          setStoredProject(value === 'all' ? null : value.slice(3))
          if (projectId) {
            onClearProject?.()
          }
        }}
      >
        <SelectTrigger size="sm" aria-label={t('commander.memory.scope', 'Memory project')}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">{t('commander.memory.all', 'All projects')}</SelectItem>
          {projects.map((id) => (
            <SelectItem value={`id:${id}`} key={id}>
              {id}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {scope && <CommanderMemoryGrant key={scope} account={account} projectId={scope} />}
      <div className="flex flex-wrap items-center gap-2">
        <Select value={view} onValueChange={setView}>
          <SelectTrigger size="sm" aria-label={t('commander.memory.kind', 'Page type')}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t('commander.rules.allPages', 'All pages')}</SelectItem>
            <SelectItem value="rules">
              {t('commander.rules.plural', 'Recurring answers')}
            </SelectItem>
            <SelectItem value="decisions">{t('commander.rules.decisions', 'Decisions')}</SelectItem>
          </SelectContent>
        </Select>
        <Input
          type="search"
          maxLength={512}
          className="min-w-32 flex-1"
          aria-label={t('commander.memory.search', 'Search memory pages')}
          placeholder={t('commander.memory.search', 'Search memory pages')}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <Button
          size="sm"
          onClick={() =>
            setSelected({ pageId: createBrowserUuid(), projectId: scope, isNew: true })
          }
        >
          <Plus />
          {t('commander.memory.newPage', 'New page')}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={!projects.length}
          onClick={() =>
            setSelected({
              pageId: createBrowserUuid(),
              projectId: scope,
              isNew: true,
              recurring: true
            })
          }
        >
          {t('commander.rules.new', 'New recurring answer')}
        </Button>
      </div>
      <label className="flex items-center gap-2 text-xs text-muted-foreground">
        <Checkbox checked={deleted} onCheckedChange={(value) => setDeleted(value === true)} />
        {t('commander.memory.includeDeleted', 'Include deleted pages')}
      </label>
      {error && (
        <div role="alert" className="flex items-center gap-2 text-sm text-destructive">
          {error}
          <Button variant="outline" size="xs" onClick={index.refresh}>
            {t('commander.memory.retry', 'Retry')}
          </Button>
        </div>
      )}
      {!loaded && !error && (
        <p role="status" className="text-sm text-muted-foreground">
          {t('commander.memory.loadingPages', 'Loading pages…')}
        </p>
      )}
      {loaded && !error && pages.length === 0 && (
        <p className="text-sm text-muted-foreground">
          {search
            ? t('commander.memory.noMatches', 'No matching pages.')
            : t('commander.memory.empty', 'No memory pages in this view.')}
        </p>
      )}
      <ul className="divide-y divide-border">
        {pages.map((page) => (
          <li key={page.pageId}>
            <button
              type="button"
              onClick={() => openPage(page)}
              className="flex w-full items-start gap-3 rounded-md px-2 py-3 text-left hover:bg-accent hover:text-accent-foreground focus-visible:outline-ring"
            >
              <BookOpen className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0">
                <span className="block break-words text-sm font-medium">
                  {page.recurringQuestion ?? page.title}
                </span>
                <span className="block break-words text-xs text-muted-foreground">
                  {[
                    page.recurringQuestion
                      ? t('commander.rules.singular', 'Recurring answer')
                      : memoryKind(t, page.kind),
                    page.projectId ?? t('commander.memory.account', 'Account'),
                    page.deleted ? t('commander.memory.deleted', 'Deleted') : null,
                    `v${page.version}`,
                    memoryActor(t, page.actor.type),
                    page.actor.id
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
              </span>
            </button>
          </li>
        ))}
      </ul>
      <CommanderMemoryPagination {...index} />
    </section>
  )
}
