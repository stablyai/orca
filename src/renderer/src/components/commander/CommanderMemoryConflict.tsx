import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import type {
  CommanderMemoryRevision,
  CommanderMemorySummary
} from '../../../../shared/commander/memory-contract'
import { Revision } from './CommanderMemoryHistory'

export function CommanderMemoryConflict({
  page,
  pages,
  baseLinks,
  draftLinks,
  onRebase
}: {
  page: CommanderMemoryRevision
  pages: CommanderMemorySummary[]
  baseLinks: string[]
  draftLinks: string[]
  onRebase: (links: string[]) => void
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <div className="space-y-2 rounded-md border border-border p-3">
      <p role="alert">
        {page.deleted
          ? t('commander.memory.staleDeleted', 'This page was deleted while you were editing.')
          : t('commander.memory.staleChanged', 'This page changed while you were editing.')}{' '}
        {t('commander.memory.compare', 'Compare your draft with revision {{version}}.', {
          version: page.version
        })}
      </p>
      <h3 className="font-medium">{page.title}</h3>
      <Revision page={page} />
      <div>
        <span className="text-xs text-muted-foreground">
          {t('commander.memory.related', 'Related pages')}
        </span>
        {page.links.length ? (
          <ul className="list-inside list-disc">
            {page.links.map((id) => {
              const linked = pages.find((item) => item.pageId === id)
              return (
                <li key={id}>
                  {linked && <>{linked.title} · </>}
                  <code className="break-all text-xs">{id}</code>
                </li>
              )
            })}
          </ul>
        ) : (
          <span> —</span>
        )}
      </div>
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={() => {
          const retained = page.links.filter(
            (id) => !baseLinks.includes(id) || draftLinks.includes(id)
          )
          const added = draftLinks.filter(
            (id) => !baseLinks.includes(id) && !page.links.includes(id)
          )
          onRebase([...retained, ...added])
        }}
      >
        {page.deleted
          ? t('commander.memory.rebaseDeleted', 'Use my draft to restore this revision')
          : t('commander.memory.rebase', 'Keep my draft against this revision')}
      </Button>
    </div>
  )
}
