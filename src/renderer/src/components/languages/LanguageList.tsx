import { useId } from 'react'
import { MessageSquarePlus, Puzzle, RotateCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { LoadingSpinner } from '@/components/ui/LoadingSpinner'
import { useTranslate } from '@/i18n/use-translate'
import { LanguagePackRow, type LanguageRowModel } from './LanguagePackRow'

type LanguageCatalogStatus = 'loading' | 'error' | 'ready'

export type LanguageListProps = {
  query: string
  builtIns: LanguageRowModel[]
  community: LanguageRowModel[]
  /** The device-match community pack, pinned above every group with no header of its own. */
  pinned: LanguageRowModel | null
  catalogStatus: LanguageCatalogStatus
  /** False where packs cannot be installed (web client): only installed packs are listed. */
  catalogSupported: boolean
  /** Plugins are off: the notice above the list stands in for the community group. */
  pluginsDisabled: boolean
  refreshing: boolean
  /** Blocks catalog refresh while a language change is in flight. */
  busy: boolean
  onRefresh: () => void
  /** Omitted where requests cannot be sent (web client). */
  onRequest?: (draft?: string) => void
  /** Omitted during onboarding and on the web client. */
  onManagePlugins?: () => void
}

const groupLabel = 'flex h-6 items-center gap-1.5 px-3 text-xs font-medium text-muted-foreground'
const stateLine = 'flex items-center gap-2 px-3 py-2.5 text-xs text-muted-foreground'

function showCommunityGroup(props: LanguageListProps): boolean {
  if (props.pluginsDisabled) {
    return false
  }
  if (!props.catalogSupported || props.query.trim() !== '') {
    return props.community.length > 0 || (props.catalogSupported && props.catalogStatus !== 'ready')
  }
  // Why: when the pinned row is the only pack, an empty group would read as "none".
  return !(props.pinned && props.community.length === 0 && props.catalogStatus === 'ready')
}

/** True when a search matched nothing, so the list shows its own next steps. */
export function isLanguageSearchEmpty(props: LanguageListProps): boolean {
  return (
    props.query.trim() !== '' &&
    !props.pinned &&
    props.builtIns.length === 0 &&
    !showCommunityGroup(props)
  )
}

export function LanguageList(props: LanguageListProps): React.JSX.Element {
  if (isLanguageSearchEmpty(props)) {
    return <NoMatches {...props} />
  }
  return (
    <div className="flex flex-col gap-3">
      {props.pinned && (
        <ul className="flex flex-col">
          <LanguagePackRow row={props.pinned} />
        </ul>
      )}
      {props.builtIns.length > 0 && <BuiltInGroup rows={props.builtIns} />}
      {showCommunityGroup(props) && <CommunityGroup {...props} />}
    </div>
  )
}

function BuiltInGroup({ rows }: { rows: LanguageRowModel[] }): React.JSX.Element {
  const t = useTranslate()
  const headingId = useId()
  return (
    <section aria-labelledby={headingId}>
      <h3 id={headingId} className={groupLabel}>
        {t('languages.builtIn', 'Built in')}
      </h3>
      <ul className="flex flex-col">
        {rows.map((row) => (
          <LanguagePackRow key={row.id} row={row} />
        ))}
      </ul>
    </section>
  )
}

function CommunityGroup({
  query,
  community,
  catalogStatus,
  catalogSupported,
  refreshing,
  busy,
  onRefresh
}: LanguageListProps): React.JSX.Element {
  const t = useTranslate()
  const headingId = useId()
  const searching = query.trim() !== ''
  const refreshLabel = t('languages.refresh', 'Check for new translations')
  const loading = catalogSupported && catalogStatus === 'loading'
  return (
    <section aria-labelledby={headingId} data-community-group="" className="group/community">
      <div className="flex h-6 items-center justify-between gap-2 pr-1">
        <h3 id={headingId} className={groupLabel}>
          {t('languages.community', 'Community translations')}
          {loading && <LoadingSpinner className="size-3" />}
        </h3>
        {catalogSupported && catalogStatus === 'ready' && (
          // Why hover-only: refresh is rarely needed; the catalog already revalidates on open.
          <span className="opacity-0 transition-opacity group-hover/community:opacity-100 group-focus-within/community:opacity-100">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  size="icon-xs"
                  variant="muted-field-icon"
                  aria-label={refreshLabel}
                  disabled={refreshing || busy}
                  onClick={onRefresh}
                >
                  {refreshing ? <LoadingSpinner className="size-3" /> : <RotateCw />}
                </Button>
              </TooltipTrigger>
              <TooltipContent side="left" sideOffset={4}>
                {refreshLabel}
              </TooltipContent>
            </Tooltip>
          </span>
        )}
      </div>
      <ul className="flex flex-col">
        {community.map((row) => (
          <LanguagePackRow key={row.id} row={row} />
        ))}
      </ul>
      {loading && (
        <p role="status" className={stateLine}>
          <LoadingSpinner className="size-3.5" />
          {t('languages.loadingPacks', 'Looking for community translations…')}
        </p>
      )}
      {catalogSupported && catalogStatus === 'error' && (
        <p className={stateLine}>
          {t('languages.catalogFailed', 'Couldn’t load community translations.')}
          <Button size="xs" variant="link" disabled={refreshing || busy} onClick={onRefresh}>
            {refreshing ? <LoadingSpinner className="size-3" /> : <RotateCw />}
            {t('languages.retry', 'Retry')}
          </Button>
        </p>
      )}
      {catalogStatus === 'ready' && community.length === 0 && !searching && (
        <p className={stateLine}>{t('languages.noPacks', 'No community translations yet.')}</p>
      )}
    </section>
  )
}

function NoMatches({ query, onRequest, onManagePlugins }: LanguageListProps): React.JSX.Element {
  const t = useTranslate()
  const trimmed = query.trim()
  return (
    <div role="status" className="flex flex-col items-center gap-2 px-3 py-8 text-center">
      <p className="text-sm text-muted-foreground">
        {t('languages.noMatches', 'No languages match “{{query}}”.', { query: trimmed })}
      </p>
      {(onRequest || onManagePlugins) && (
        <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1">
          {onRequest && (
            <Button size="inline" variant="link" onClick={() => onRequest(trimmed)}>
              <MessageSquarePlus />
              {t('languages.requestQuery', 'Request “{{query}}”', { query: trimmed })}
            </Button>
          )}
          {onManagePlugins && (
            <Button size="inline" variant="link" onClick={onManagePlugins}>
              <Puzzle />
              {t('languages.managePacks', 'Browse in Plugins')}
            </Button>
          )}
        </div>
      )}
    </div>
  )
}
