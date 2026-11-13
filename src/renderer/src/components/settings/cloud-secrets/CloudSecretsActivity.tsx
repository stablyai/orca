import { useState } from 'react'
import { History } from 'lucide-react'
import { formatUiRelativeTime } from '@/i18n/relative-time-format'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import type {
  CloudSecretActivityView,
  CloudSecretEvent
} from '../../../../../shared/cloud-secrets/cloud-secrets-wire'
import { Badge } from '../../ui/badge'
import { Button } from '../../ui/button'
import { InlineError } from '../../ui/inline-error'
import { Skeleton } from '../../ui/skeleton'
import { Tabs, TabsList, TabsTrigger } from '../../ui/tabs'
import { CloudApiEmptyState } from '../cloud-api/cloud-api-parts'
import { cloudSecretScopeLabel, cloudSecretsErrorCopy } from './cloud-secrets-copy'
import type { CloudSecretPeople } from './CloudSecretList'
import { useCloudSecretActivity } from './use-cloud-secret-activity'
import type { CloudSecretsApi } from './use-cloud-secrets'

function actionLabel(action: CloudSecretEvent['action'], t: Translate): string {
  switch (action) {
    case 'created':
      return t('cloudSecrets.activity.created', 'Added')
    case 'updated':
      return t('cloudSecrets.activity.updated', 'Changed')
    case 'deleted':
      return t('cloudSecrets.activity.deleted', 'Deleted')
  }
}

function repoLabel(repo: string): string {
  return repo.replace(/^github\.com\//, '')
}

function ActivityRow({
  event,
  people,
  now
}: {
  event: CloudSecretEvent
  people: CloudSecretPeople
  now: number
}): React.JSX.Element {
  const t = useTranslate()
  const who =
    event.actor.userId === people.viewerUserId
      ? t('cloudSecrets.activity.byYou', 'You')
      : (people.nameFor(event.actor.userId) ??
        event.actor.name ??
        t('cloudSecrets.activity.byTeammate', 'A teammate'))
  return (
    <li className="flex min-h-9 items-center gap-3 px-3 py-2 text-xs" data-secret-event={event.id}>
      <span className="w-16 shrink-0 text-muted-foreground">{actionLabel(event.action, t)}</span>
      <code className="min-w-0 flex-1 font-mono break-all">{event.name}</code>
      <Badge variant="outline" className="max-w-40 shrink-0 truncate">
        {event.scope === 'repo' && event.repo
          ? repoLabel(event.repo)
          : cloudSecretScopeLabel(event.scope, t)}
      </Badge>
      <span
        className="w-40 shrink-0 truncate text-muted-foreground"
        title={new Date(event.at).toLocaleString()}
      >
        {t('cloudSecrets.activity.byWhen', '{{who}} · {{when}}', {
          who,
          when: formatUiRelativeTime(Math.min(0, event.at - now))
        })}
      </span>
    </li>
  )
}

/** Who added, changed or deleted which secret, last 90 days. Names only: values are never recorded. */
export function CloudSecretsActivity({
  api,
  people,
  canSeeTeam
}: {
  api: CloudSecretsApi
  people: CloudSecretPeople
  /** Team owners and admins also see the team's log; everyone sees their own. */
  canSeeTeam: boolean
}): React.JSX.Element {
  const t = useTranslate()
  const [picked, setPicked] = useState<CloudSecretActivityView>('team')
  const view: CloudSecretActivityView = canSeeTeam ? picked : 'personal'
  const model = useCloudSecretActivity(api, view)
  const [now] = useState(() => Date.now())

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <p className="flex-1 text-xs leading-5 text-muted-foreground">
          {view === 'team'
            ? t(
                'cloudSecrets.activity.teamDescription',
                'Who added, changed or deleted your team’s shared and repository secrets in the last 90 days. Values are never recorded.'
              )
            : t(
                'cloudSecrets.activity.personalDescription',
                'Changes you made to your own secrets in the last 90 days. Values are never recorded.'
              )}
        </p>
        {canSeeTeam ? (
          <Tabs
            value={view}
            onValueChange={(next) => (next === 'team' || next === 'personal') && setPicked(next)}
          >
            <TabsList size="sm">
              <TabsTrigger value="team">{t('cloudSecrets.activity.team', 'Team')}</TabsTrigger>
              <TabsTrigger value="personal">
                {t('cloudSecrets.activity.personal', 'Yours')}
              </TabsTrigger>
            </TabsList>
          </Tabs>
        ) : null}
      </div>

      {model.status === 'loading' ? (
        <div className="space-y-px rounded-md border border-border/60" aria-busy="true">
          {[0, 1, 2].map((row) => (
            <div key={row} className="flex items-center gap-3 px-3 py-2.5">
              <Skeleton className="h-3 w-12" />
              <Skeleton className="h-3 w-40" />
              <Skeleton className="ml-auto h-3 w-24" />
            </div>
          ))}
          <span className="sr-only">{t('cloudSecrets.activity.loading', 'Loading activity…')}</span>
        </div>
      ) : model.status === 'failed' ? (
        <InlineError
          title={cloudSecretsErrorCopy(model.error ?? 'unknown', t)}
          retryLabel={t('cloudSecrets.list.retry', 'Try again')}
          onRetry={model.reload}
        />
      ) : model.events.length === 0 ? (
        <div className="rounded-md border border-border/60">
          <CloudApiEmptyState
            icon={History}
            title={t('cloudSecrets.activity.emptyTitle', 'No changes in the last 90 days')}
            description={t(
              'cloudSecrets.activity.emptyDetail',
              'When a secret is added, changed or deleted, it shows up here with who did it.'
            )}
          />
        </div>
      ) : (
        <>
          <ul className="divide-y divide-border/60 overflow-hidden rounded-md border border-border/60">
            {model.events.map((event) => (
              <ActivityRow key={event.id} event={event} people={people} now={now} />
            ))}
          </ul>
          {model.error ? (
            <InlineError
              title={cloudSecretsErrorCopy(model.error, t)}
              retryLabel={t('cloudSecrets.list.retry', 'Try again')}
              onRetry={model.loadMore ?? model.reload}
            />
          ) : null}
          {model.loadMore ? (
            <Button
              variant="outline"
              size="sm"
              disabled={model.loadingMore}
              onClick={model.loadMore}
            >
              {model.loadingMore
                ? t('cloudSecrets.activity.loadingMore', 'Loading…')
                : t('cloudSecrets.activity.showOlder', 'Show older')}
            </Button>
          ) : null}
        </>
      )}
    </div>
  )
}
