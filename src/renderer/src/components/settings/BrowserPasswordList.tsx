import { Copy, MoreHorizontal, Pencil, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { translate } from '@/i18n/i18n'
import { formatUiRelativeTime } from '@/i18n/relative-time-format'
import type { BrowserPasswordEntrySummary } from '../../../../shared/browser-passwords-types'
import { browserPasswordHostOf } from './browser-password-import-toast'

export type BrowserPasswordRowActions = {
  onCopy: (entry: BrowserPasswordEntrySummary) => void
  onEdit: (entry: BrowserPasswordEntrySummary) => void
  onDelete: (entry: BrowserPasswordEntrySummary) => void
}

type SiteGroup = { origin: string; host: string; entries: BrowserPasswordEntrySummary[] }

function groupBySite(entries: BrowserPasswordEntrySummary[]): SiteGroup[] {
  const groups = new Map<string, SiteGroup>()
  for (const entry of entries) {
    const group = groups.get(entry.origin) ?? {
      origin: entry.origin,
      host: browserPasswordHostOf(entry.origin),
      entries: []
    }
    group.entries.push(entry)
    groups.set(entry.origin, group)
  }
  for (const group of groups.values()) {
    group.entries.sort((a, b) => a.username.localeCompare(b.username))
  }
  return [...groups.values()].sort(
    (a, b) => a.host.localeCompare(b.host) || a.origin.localeCompare(b.origin)
  )
}

function usernameText(entry: BrowserPasswordEntrySummary): string {
  return entry.username || translate('settings.browser.passwords.noUsername', '(no username)')
}

function SiteTile({ host }: { host: string }): React.JSX.Element {
  const letter = host.replace(/^www\./, '').match(/[a-z0-9]/i)?.[0] ?? '?'
  return (
    <span
      aria-hidden
      className="flex size-6 shrink-0 items-center justify-center rounded-sm bg-muted text-2xs font-medium text-muted-foreground uppercase"
    >
      {letter}
    </span>
  )
}

/** Host, plus the scheme when it is plain http so it can't pass for the https login. */
function SiteName({ group }: { group: SiteGroup }): React.JSX.Element {
  return (
    <div className="truncate text-sm">
      {group.host}
      {group.origin.startsWith('http:') ? (
        <span className="text-2xs text-muted-foreground">
          {translate('settings.browser.passwords.httpSuffix', ' · http')}
        </span>
      ) : null}
    </div>
  )
}

function PasswordRow({
  entry,
  group,
  nested,
  now,
  actions
}: {
  entry: BrowserPasswordEntrySummary
  group: SiteGroup
  nested: boolean
  now: number
  actions: BrowserPasswordRowActions
}): React.JSX.Element {
  const account = translate('settings.browser.passwords.account', '{{username}} on {{site}}', {
    username: usernameText(entry),
    site: group.host
  })
  const lastUsed =
    entry.lastUsedAt === null
      ? null
      : translate('settings.browser.passwords.lastUsed', 'Used {{when}}', {
          when: formatUiRelativeTime(entry.lastUsedAt - now)
        })
  return (
    <div className="group/pw flex items-center gap-3 rounded-md px-2 py-2 transition-colors hover:bg-accent/60 focus-within:bg-accent/60">
      {nested ? <span aria-hidden className="w-6 shrink-0" /> : <SiteTile host={group.host} />}
      <div className="min-w-0 flex-1">
        {nested ? null : <SiteName group={group} />}
        <div className={nested ? 'truncate text-sm' : 'truncate text-xs text-muted-foreground'}>
          {usernameText(entry)}
        </div>
      </div>
      {lastUsed ? <div className="shrink-0 text-2xs text-muted-foreground">{lastUsed}</div> : null}
      {/* Touch devices cannot hover, so keep actions visible there. */}
      <div className="flex shrink-0 items-center gap-0.5 transition-opacity can-hover:opacity-0 group-hover/pw:opacity-100 group-focus-within/pw:opacity-100 has-[[data-state=open]]:opacity-100">
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={translate(
            'settings.browser.passwords.copyFor',
            'Copy password for {{account}}',
            {
              account
            }
          )}
          title={translate('settings.browser.passwords.copy', 'Copy password')}
          onClick={() => actions.onCopy(entry)}
        >
          <Copy />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={translate('settings.browser.passwords.editFor', 'Edit {{account}}', {
            account
          })}
          title={translate('settings.browser.passwords.edit', 'Edit')}
          onClick={() => actions.onEdit(entry)}
        >
          <Pencil />
        </Button>
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={translate(
                'settings.browser.passwords.moreActions',
                'More actions for {{account}}',
                { account }
              )}
            >
              <MoreHorizontal />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-36">
            <DropdownMenuItem variant="destructive" onSelect={() => actions.onDelete(entry)}>
              <Trash2 />
              {translate('settings.browser.passwords.delete', 'Delete…')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  )
}

export function BrowserPasswordList({
  entries,
  now,
  actions
}: {
  entries: BrowserPasswordEntrySummary[]
  /** When the list was loaded; "used 2 days ago" is measured from here. */
  now: number
  actions: BrowserPasswordRowActions
}): React.JSX.Element {
  return (
    // Why a capped scroll box: a vault can hold hundreds of logins and must not push the rest of Settings away.
    <div className="scrollbar-sleek max-h-[min(26rem,55vh)] divide-y divide-border/50 overflow-y-auto overscroll-contain rounded-md border border-border/50 p-1">
      {groupBySite(entries).map((group) =>
        group.entries.length === 1 ? (
          <PasswordRow
            key={group.origin}
            entry={group.entries[0]}
            group={group}
            nested={false}
            now={now}
            actions={actions}
          />
        ) : (
          <div key={group.origin}>
            <div className="flex items-center gap-3 px-2 pt-2 pb-1">
              <SiteTile host={group.host} />
              <div className="min-w-0 flex-1">
                <SiteName group={group} />
                <div className="text-xs text-muted-foreground">
                  {translate('settings.browser.passwords.accountCount', '{{count}} accounts', {
                    count: group.entries.length
                  })}
                </div>
              </div>
            </div>
            {group.entries.map((entry) => (
              <PasswordRow
                key={entry.id}
                entry={entry}
                group={group}
                nested
                now={now}
                actions={actions}
              />
            ))}
          </div>
        )
      )}
    </div>
  )
}
