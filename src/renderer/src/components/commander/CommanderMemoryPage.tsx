import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createNonSecureContextUuid as createBrowserUuid } from '../../../../shared/identifiers/non-secure-context-uuid'
import { memoryKind, memoryActor } from './commander-memory-labels'
import { useTranslate } from '@/i18n/use-translate'
import { CommanderMemoryConflict } from './CommanderMemoryConflict'
import { CommanderMemoryLinks } from './CommanderMemoryLinks'
import { useCommanderPageSummaries } from './use-commander-page-summaries'
import { ArrowLeft } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { CommanderMemoryFields, type MemoryDraft } from './CommanderMemoryFields'
import {
  formatRecurringAnswer,
  humanRecurringAnswer,
  recurringAnswerTitle
} from '../../../../shared/commander/recurring-answer'
import { MemoryHistory, Revision } from './CommanderMemoryHistory'
import type {
  CommanderAccount,
  CommanderMemoryRevision,
  CommanderMemorySummary,
  CommanderMemoryWrite
} from '../../../../shared/commander/memory-contract'

type Props = {
  account: CommanderAccount
  selected: { pageId: string; projectId: string | null; isNew: boolean; recurring?: boolean }
  projects?: readonly string[]
  pages: CommanderMemorySummary[]
  onBack: () => void
  onOpen: (page: Pick<CommanderMemorySummary, 'pageId' | 'projectId'>) => void
}

function draftOf(page: CommanderMemoryRevision): MemoryDraft {
  return {
    recurring: humanRecurringAnswer(page) ?? undefined,
    title: page.title,
    body: page.body,
    kind: page.kind,
    projectId: page.projectId,
    links: page.links,
    base: page.version,
    baseLinks: page.links
  }
}

export function CommanderMemoryPage({
  account,
  selected,
  projects,
  pages: listedPages,
  onBack,
  onOpen
}: Props): React.JSX.Element {
  const t = useTranslate()
  const { pageId, projectId, isNew } = selected
  const [history, setHistory] = useState<CommanderMemoryRevision[]>([])
  const [historyCursor, setHistoryCursor] = useState<number | null>(null)
  const page = history[0]
  const [draft, setDraft] = useState<MemoryDraft | null>(() =>
    isNew
      ? {
          title: selected.recurring ? recurringAnswerTitle : '',
          body: '',
          kind: selected.recurring ? 'guideline' : 'note',
          recurring: selected.recurring ? { question: '', answer: '' } : undefined,
          links: [],
          projectId,
          base: 0,
          baseLinks: []
        }
      : null
  )
  const [confirmDelete, setConfirmDelete] = useState<number | null>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const [readError, setReadError] = useState('')
  const request = useRef<{ payload: string; id: string } | null>(null)
  const readEpoch = useRef(0)
  const mutationInFlight = useRef(false)
  const currentLinks = page?.links
  const draftLinks = draft?.links
  const saved = !!page
  const ids = useMemo(
    () => [
      ...new Set([...(saved ? [pageId] : []), ...(currentLinks ?? []), ...(draftLinks ?? [])])
    ],
    [pageId, saved, currentLinks, draftLinks]
  )
  const related = useCommanderPageSummaries(account, ids)
  const pages = [...related.pages, ...listedPages]
  const latest = Math.max(
    listedPages.find((item) => item.pageId === pageId)?.version ?? 0,
    related.pages.find((item) => item.pageId === pageId)?.version ?? 0
  )
  const version = page?.version ?? 0
  const refresh = useCallback(async () => {
    const epoch = ++readEpoch.current
    try {
      const data = await window.api.commanderMemory.get(account, pageId)
      if (epoch === readEpoch.current) {
        setHistory([data.page, ...data.history.filter((item) => item.version < data.page.version)])
        setHistoryCursor(data.nextBeforeVersion ?? null)
        setReadError('')
      }
    } catch (reason) {
      if (epoch === readEpoch.current) {
        setReadError(
          reason instanceof Error
            ? reason.message
            : t('commander.memory.readError', 'Could not load this page.')
        )
      }
    }
  }, [account, pageId, t])
  useEffect(() => {
    if ((!isNew && version === 0) || latest > version) {
      void refresh()
    }
  }, [isNew, latest, version, refresh])

  async function save(change: CommanderMemoryWrite): Promise<void> {
    if (mutationInFlight.current) {
      return
    }
    mutationInFlight.current = true
    setPending(true)
    setError('')
    const payload = JSON.stringify(change)
    if (request.current?.payload !== payload) {
      request.current = { payload, id: createBrowserUuid() }
    }
    try {
      const result = await window.api.commanderMemory.save(account, {
        ...change,
        requestId: request.current.id
      })
      readEpoch.current++
      setHistory([result.page])
      setHistoryCursor(null)
      setDraft(null)
      setConfirmDelete(null)
      request.current = null
      void refresh()
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : t('commander.memory.saveError', 'Could not save the page.')
      )
      if (page || !isNew) {
        void refresh()
      }
    }
    mutationInFlight.current = false
    setPending(false)
  }

  const stale = Boolean(draft && page && draft.base < page.version)
  const oversized = draft ? new TextEncoder().encode(draft.body).byteLength > 65_536 : false
  const incomplete =
    !draft?.title.trim() ||
    Boolean(
      draft.recurring &&
      (!draft.projectId || !draft.recurring.question.trim() || !draft.recurring.answer.trim())
    )
  return (
    <section className="space-y-4 px-4 py-3 text-sm">
      {!draft && (
        <Button variant="ghost" size="sm" disabled={pending} onClick={onBack}>
          <ArrowLeft />
          {t('commander.memory.pages', 'Pages')}
        </Button>
      )}
      {!(draft?.recurring && draft.base === 0) && (
        <p className="break-words font-mono text-xs text-muted-foreground">
          {page?.projectId ?? projectId ?? t('commander.memory.global', 'Account-wide')}
        </p>
      )}
      {(readError || related.error) && (
        <div role="alert" className="flex items-center gap-2 text-destructive">
          {readError || related.error}
          <Button
            size="xs"
            variant="outline"
            onClick={() => void (readError ? refresh() : related.refresh())}
          >
            {t('commander.memory.retry', 'Retry')}
          </Button>
        </div>
      )}
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      {draft ? (
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault()
            if (stale || oversized || incomplete) {
              return
            }
            void save({
              pageId,
              requestId: '',
              expectedVersion: draft.base,
              title: draft.title.trim(),
              body: draft.recurring
                ? formatRecurringAnswer(
                    draft.recurring.question.trim(),
                    draft.recurring.answer.trim()
                  )
                : draft.body,
              kind: draft.kind,
              projectId: draft.projectId,
              links: draft.links
            })
          }}
        >
          <fieldset disabled={pending} className="space-y-3">
            <CommanderMemoryFields
              draft={draft}
              setDraft={setDraft}
              oversized={oversized}
              projects={projects ?? []}
            />
            <CommanderMemoryLinks
              account={account}
              links={draft.links}
              pages={pages}
              pageId={pageId}
              pending={pending}
              onChange={(links) => setDraft({ ...draft, links })}
            />
            {stale && page && (
              <CommanderMemoryConflict
                page={page}
                pages={pages}
                baseLinks={draft.baseLinks}
                draftLinks={draft.links}
                onRebase={(links) =>
                  setDraft({ ...draft, base: page.version, baseLinks: page.links, links })
                }
              />
            )}
            <div className="flex gap-2">
              <Button
                type="submit"
                size="sm"
                disabled={pending || stale || oversized || incomplete}
              >
                {pending
                  ? t('commander.memory.saving', 'Saving…')
                  : t('commander.memory.saveRevision', 'Save revision')}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => {
                  setError('')
                  setDraft(null)
                  if (!page) {
                    onBack()
                  }
                }}
              >
                {t('commander.memory.cancel', 'Cancel')}
              </Button>
            </div>
          </fieldset>
        </form>
      ) : page ? (
        <>
          <div className="space-y-1">
            <p className="text-xs text-muted-foreground">
              {memoryKind(t, page.kind)} ·{' '}
              {t('commander.memory.version', 'v{{version}}', { version: page.version })} ·{' '}
              {t('commander.memory.creator', 'Created by {{actor}}', {
                actor: memoryActor(t, page.createdBy.type)
              })}{' '}
              · {page.createdBy.id}
            </p>
            <h2 className="break-words text-lg font-semibold">
              {humanRecurringAnswer(page)
                ? t('commander.rules.singular', 'Recurring answer')
                : page.title}
            </h2>
          </div>
          <Revision page={page} />
          {page.links.length > 0 && (
            <nav
              aria-label={t('commander.memory.related', 'Related pages')}
              className="flex flex-wrap items-center gap-2"
            >
              <span className="text-xs text-muted-foreground">
                {t('commander.memory.related', 'Related pages')}
              </span>
              {page.links.map((id) => {
                const linked = pages.find((item) => item.pageId === id)
                return (
                  <Button
                    key={id}
                    size="xs"
                    variant="link"
                    disabled={pending}
                    onClick={() => onOpen(linked ?? { pageId: id })}
                  >
                    {linked?.title ?? id}
                  </Button>
                )
              })}
            </nav>
          )}
          {!page.recurringAnswerReceipt && (
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={pending}
                onClick={() => {
                  setConfirmDelete(null)
                  setError('')
                  setDraft(draftOf(page))
                }}
              >
                {page.deleted
                  ? t('commander.memory.restore', 'Restore page')
                  : t('commander.memory.edit', 'Edit page')}
              </Button>
              {!page.deleted && confirmDelete === null && (
                <Button
                  variant="ghost-destructive"
                  size="sm"
                  onClick={() => setConfirmDelete(page.version)}
                >
                  {t('commander.memory.deletePage', 'Delete page')}
                </Button>
              )}
              {confirmDelete !== null && (
                <>
                  <Button
                    size="sm"
                    variant="destructive"
                    disabled={pending || page.version !== confirmDelete}
                    onClick={() =>
                      void save({
                        pageId,
                        requestId: '',
                        expectedVersion: confirmDelete,
                        deleted: true
                      })
                    }
                  >
                    {t('commander.memory.confirmDelete', 'Confirm deletion')}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={pending}
                    onClick={() => setConfirmDelete(null)}
                  >
                    {t('commander.memory.cancel', 'Cancel')}
                  </Button>
                </>
              )}
            </div>
          )}
          <MemoryHistory
            key={page.version}
            history={history}
            initialCursor={historyCursor}
            account={account}
            onRefresh={() => void refresh()}
          />
        </>
      ) : (
        !readError && (
          <p role="status" className="text-muted-foreground">
            {t('commander.memory.loadingPage', 'Loading page…')}
          </p>
        )
      )}
    </section>
  )
}
