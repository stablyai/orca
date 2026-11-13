import { useMemo, useRef, useState } from 'react'
import { FlaskConical, RefreshCw, Users } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { useIntlLocale, useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '@/store'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { useCommunityNavigation } from './community-navigation'
import { useCommunityCatalog } from './use-community-catalog'
import { communityClient } from './community-client'
import { CommunityCatalog } from './CommunityCatalog'
import { CommunityProposalDetail } from './CommunityProposalDetail'
import { CommunityActivity } from './CommunityActivity'
import { CommunityChangelog } from './CommunityChangelog'
import { CommunityCustomManager } from './CommunityCustomManager'
export default function CommunityPage(): React.JSX.Element {
  const t = useTranslate()
  const locale = useIntlLocale()
  const section = useCommunityNavigation((state) => state.section)
  const query = useCommunityNavigation((state) => state.query)
  const number = useCommunityNavigation((state) => state.number)
  const setSection = useCommunityNavigation((state) => state.setSection)
  const setQuery = useCommunityNavigation((state) => state.setQuery)
  const open = useCommunityNavigation((state) => state.open)
  const environments = useAppStore((state) => state.runtimeEnvironments)
  const [host, setHost] = useState('local')
  const target = useMemo<RuntimeClientTarget>(
    () => (host === 'local' ? { kind: 'local' } : { kind: 'environment', environmentId: host }),
    [host]
  )
  const catalog = useCommunityCatalog(target, query)
  const [accounts, setAccounts] = useState<{ selected: string | null; users: string[] } | null>(
    null
  )
  const [accountError, setAccountError] = useState<string | null>(null)
  const accountRequest = useRef(0)
  const [accountBusy, setAccountBusy] = useState(false)
  const chooseAccount = async (user?: string | null): Promise<void> => {
    const request = ++accountRequest.current
    setAccountBusy(true)
    setAccountError(null)
    try {
      const client = communityClient(target)
      if (user !== undefined) {
        await client.account(user)
      }
      const result = await client.accounts()
      if (request === accountRequest.current) {
        setAccounts(result)
        catalog.retry()
      }
    } catch (cause) {
      if (request === accountRequest.current) {
        setAccountError(cause instanceof Error ? cause.message : String(cause))
      }
    } finally {
      if (request === accountRequest.current) {
        setAccountBusy(false)
      }
    }
  }
  return (
    <main
      className="h-full w-full overflow-auto bg-background text-foreground scrollbar-sleek"
      aria-label={t('community.page', 'Orca Community')}
    >
      <div className="mx-auto max-w-7xl space-y-6 px-8 py-7 max-md:px-4 max-sm:space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Users className="size-4" />
            {t('community.page', 'Orca Community')}
            <Badge variant="outline">{t('community.experimental', 'Experimental')}</Badge>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Select
              value={host}
              onValueChange={(value) => {
                accountRequest.current++
                setAccountBusy(false)
                setHost(value)
                setAccounts(null)
                setAccountError(null)
                open(null)
              }}
            >
              <SelectTrigger
                className="w-44 max-sm:w-32"
                aria-label={t('community.dataHost', 'Community data host')}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="local">{t('community.thisDevice', 'This Orca')}</SelectItem>
                {environments.map((environment) => (
                  <SelectItem value={environment.id} key={environment.id}>
                    {environment.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button variant="outline" disabled={accountBusy} onClick={() => void chooseAccount()}>
              <span className="max-sm:hidden">
                {t('community.githubAccount', 'GitHub account')}
              </span>
              <span className="sm:hidden">{t('community.sourceProvider', 'GitHub')}</span>
            </Button>
            <Button
              variant="outline"
              disabled={catalog.refreshing}
              onClick={() => void catalog.refresh()}
            >
              <RefreshCw
                className={`size-4 ${catalog.refreshing ? 'animate-spin motion-reduce:animate-none' : ''}`}
              />
              {catalog.refreshing
                ? t('community.refreshing', 'Refreshing…')
                : t('community.refresh', 'Refresh')}
            </Button>
          </div>
        </div>
        {catalog.refreshing && (
          <div
            role="status"
            className="flex items-center justify-between gap-3 rounded-lg bg-muted p-3 text-xs"
          >
            <span>
              {t('community.loadingGitHubPages', 'Loading GitHub pages')} ·{' '}
              {catalog.sync?.pages ?? 0} · {(catalog.sync?.received ?? 0).toLocaleString(locale)}{' '}
              {t('community.prsUnit', 'PRs')}
            </span>
            <Button variant="ghost" size="sm" onClick={() => void catalog.cancel()}>
              {t('community.cancelRefresh', 'Cancel refresh')}
            </Button>
          </div>
        )}
        {accounts && (
          <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border p-4">
            <p className="text-xs text-muted-foreground">
              {t(
                'community.accountNote',
                'Use a GitHub login on this host for a higher API limit.'
              )}
            </p>
            <Select
              value={accounts.selected ?? 'public'}
              disabled={accountBusy}
              onValueChange={(value) => void chooseAccount(value === 'public' ? null : value)}
            >
              <SelectTrigger
                className="w-48"
                aria-label={t('community.githubAccount', 'GitHub account')}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="public">
                  {t('community.publicAccess', 'Public access')}
                </SelectItem>
                {accounts.users.map((user) => (
                  <SelectItem key={user} value={user}>
                    @{user}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {!accounts.users.length && (
              <p className="text-xs text-muted-foreground">
                {t(
                  'community.noGhAccount',
                  'Sign in to GitHub CLI on this host to add an account.'
                )}
              </p>
            )}
          </div>
        )}
        {(catalog.error || accountError) && (
          <div role="alert" className="space-y-2 rounded-lg border border-border p-4 text-sm">
            <p>{accountError ?? catalog.error}</p>
            <Button variant="outline" size="sm" onClick={() => void catalog.retry()}>
              {t('community.retry', 'Retry')}
            </Button>
          </div>
        )}
        {catalog.page?.status.error && (
          <p role="status" className="rounded-lg bg-muted p-3 text-xs">
            {catalog.page.status.error}
            {catalog.page.status.retryAt &&
              ` ${new Date(catalog.page.status.retryAt).toLocaleString(locale)}`}
          </p>
        )}
        {!number && section === 'proposals' && (
          <header>
            <h1 className="max-w-3xl text-3xl font-semibold leading-tight max-sm:text-2xl">
              {query.view === 'saved'
                ? t('community.savedTitle', 'Your saved Orca changes')
                : query.view === 'viewed'
                  ? t('community.viewedTitle', 'Changes you have explored')
                  : t('community.title', 'Explore Orca changes before they’re merged.')}
            </h1>
            <p className="mt-3 max-w-2xl text-sm leading-relaxed text-muted-foreground max-sm:hidden">
              {t(
                'community.description',
                'Discover community PRs, see visual previews, and investigate with AI. These proposals are not part of official Orca yet.'
              )}
            </p>
            <p className="mt-2 text-sm text-muted-foreground sm:hidden">
              {t(
                'community.mobileDescription',
                'Preview unmerged changes. Inspect the evidence with AI.'
              )}
            </p>
            <div className="mt-4 flex flex-wrap items-center gap-3">
              <Button variant="outline" onClick={() => setSection('custom')}>
                <FlaskConical className="size-4" />
                {t('community.myAdditions', 'My Custom additions')}
              </Button>
              <span className="text-xs text-muted-foreground max-sm:hidden">
                {catalog.page?.summary.capturedAt
                  ? `${t('community.lastSync', 'Last catalog sync')} ${new Date(catalog.page.summary.capturedAt).toLocaleString(locale)}`
                  : t('community.firstSync', 'Refresh to load public proposals from GitHub.')}
              </span>
            </div>
          </header>
        )}
        {section !== 'custom' && (
          <Tabs
            value={section}
            onValueChange={(value) => {
              if (value === 'proposals' || value === 'activity' || value === 'changelog') {
                setSection(value)
              }
            }}
          >
            <TabsList variant="line" className="w-full justify-start">
              <TabsTrigger className="flex-none" value="proposals">
                {t('community.proposals', 'Proposals')}
              </TabsTrigger>
              <TabsTrigger className="flex-none" value="activity">
                {t('community.activity', 'Activity')}
              </TabsTrigger>
              <TabsTrigger className="flex-none" value="changelog">
                {t('community.changelog', 'Changelog')}
              </TabsTrigger>
            </TabsList>
          </Tabs>
        )}
        {number ? (
          <CommunityProposalDetail
            key={`${host}-${number}`}
            number={number}
            target={target}
            onBack={() => open(null)}
            mutate={catalog.mutate}
          />
        ) : section === 'changelog' ? (
          <CommunityChangelog target={target} />
        ) : catalog.page ? (
          section === 'custom' ? (
            <CommunityCustomManager
              key={host}
              personal={catalog.page.personal}
              target={target}
              onOpen={open}
              onBrowse={() => setSection('proposals')}
            />
          ) : section === 'activity' ? (
            <CommunityActivity target={target} summary={catalog.page.summary} />
          ) : (
            <CommunityCatalog
              page={catalog.page}
              query={query}
              onQuery={setQuery}
              onOpen={open}
              mutate={catalog.mutate}
              loadMore={catalog.loadMore}
              loading={catalog.loading}
            />
          )
        ) : (
          !catalog.error && (
            <p role="status" className="text-sm text-muted-foreground">
              {t('community.loading', 'Loading…')}
            </p>
          )
        )}
        <footer className="border-t border-border pt-4 text-2xs text-muted-foreground">
          {t(
            'community.sourceNote',
            'Source: stablyai/orca on GitHub. Personal saves, visits, and feature history stay on the selected host.'
          )}{' '}
          · {Intl.DateTimeFormat(locale).resolvedOptions().timeZone}
        </footer>
      </div>
    </main>
  )
}
