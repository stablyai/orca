import { useId } from 'react'
import { ArrowUpRight, Hand } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { InlineError } from '@/components/ui/inline-error'
import { Skeleton } from '@/components/ui/skeleton'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useIntlLocale, useTranslate, type Translate } from '@/i18n/use-translate'
import { cn } from '@/lib/utils'
import type { CloudWorkspace } from '../../../../shared/cloud-workspaces/cloud-workspaces-wire'
import type { OrcaOrgRole } from '../../../../shared/orca-profiles'
import type { TeammateProfile } from '../../../../shared/cloud-workspaces/team-presence-wire'
import { roleLabel } from '../billing/team/team-roles'
import { dotState, statusLabel } from '../cloud-workspaces/CloudWorkspaceRow'
import {
  formatRelative,
  initials,
  memberHue,
  repoLabel
} from '../cloud-workspaces/cloud-workspace-format'
import { cloudWorkspaceTitle } from '../cloud-workspaces/open-cloud-workspace'
import { CloudStateDot } from '../orca-cloud/CloudStateDot'
import { TeammateUsageHeatmap } from './TeammateUsageHeatmap'

export type TeammatePokeState =
  | { kind: 'idle' }
  | { kind: 'sending' }
  | { kind: 'sent'; at: number }
  | { kind: 'refused'; message: string }

export type TeammateProfileViewProps = {
  userId: string
  /** Roster name, else the control plane's, else a short id. */
  name: string
  email: string | null
  role: OrcaOrgRole | null
  profile: TeammateProfile | null
  /** Set when the profile couldn't load; the header still shows from the roster. */
  error: string | null
  poke: TeammatePokeState
  now: number
  onRetry: () => void
  onPoke: () => void
  onOpenWorkspace: (workspace: CloudWorkspace) => void
  onShowAllWorkspaces: () => void
  onTurnOnPokes: () => void
}

function LargeAvatar({ userId, name }: { userId: string; name: string }): React.JSX.Element {
  // Same per-member hue as the small avatars on workspace rows, so a teammate keeps one color.
  const hueStyle: React.CSSProperties & { '--avatar-hue': string } = {
    '--avatar-hue': String(memberHue(userId))
  }
  return (
    <span
      aria-hidden
      style={hueStyle}
      className={cn(
        'inline-flex size-12 shrink-0 select-none items-center justify-center rounded-full text-base font-medium',
        'bg-[hsl(var(--avatar-hue)_45%_88%)] text-[hsl(var(--avatar-hue)_45%_28%)]',
        'dark:bg-[hsl(var(--avatar-hue)_30%_26%)] dark:text-[hsl(var(--avatar-hue)_55%_82%)]'
      )}
    >
      {initials(name)}
    </span>
  )
}

function UsageSkeleton(): React.JSX.Element {
  return (
    <div aria-hidden className="space-y-2">
      <Skeleton className="h-[103px] w-full" shape="card" />
      <Skeleton className="h-3 w-2/3" />
    </div>
  )
}

function WorkspacesSkeleton(): React.JSX.Element {
  return (
    <div aria-hidden className="space-y-2">
      {[0, 1].map((i) => (
        <div key={i} className="flex items-center gap-3 px-2 py-1.5">
          <Skeleton shape="circle" className="size-2" />
          <div className="flex-1 space-y-1.5">
            <Skeleton className="h-3 w-40" />
            <Skeleton className="h-2.5 w-56" />
          </div>
        </div>
      ))}
    </div>
  )
}

function pokeFooterCopy(
  props: TeammateProfileViewProps,
  t: Translate
): { note: string | null; canPoke: boolean; turnOn: boolean } {
  const pokes = props.profile?.pokes
  if (!pokes || props.profile?.self) {
    return { note: null, canPoke: false, turnOn: false }
  }
  if (!pokes.enabled) {
    return {
      note: t(
        'auto.components.teammates.pokesOffYouActivity',
        'Pokes are off. Turn on Pokes and activity in Settings → Experimental.'
      ),
      canPoke: false,
      turnOn: true
    }
  }
  if (!pokes.teammateEnabled) {
    return {
      note: t('auto.components.teammates.pokesOffThem', '{{name}} hasn’t turned on Pokes yet.', {
        name: props.name
      }),
      canPoke: false,
      turnOn: false
    }
  }
  if (props.poke.kind === 'refused') {
    return { note: props.poke.message, canPoke: true, turnOn: false }
  }
  if (props.poke.kind === 'sent') {
    return {
      note: t('auto.components.teammates.poked', 'Poked {{name}}', { name: props.name }),
      canPoke: true,
      turnOn: false
    }
  }
  return { note: null, canPoke: true, turnOn: false }
}

export function TeammateProfileView(props: TeammateProfileViewProps): React.JSX.Element {
  const t = useTranslate()
  const locale = useIntlLocale()
  const { profile } = props
  const self = profile?.self ?? false
  const footer = pokeFooterCopy(props, t)
  const pokeNoteId = useId()
  const loading = profile === null && props.error === null
  return (
    <div className="flex flex-col gap-6" aria-busy={loading || undefined}>
      <header className="flex items-center gap-4 pr-8">
        <LargeAvatar userId={props.userId} name={props.name} />
        <div className="min-w-0 flex-1">
          <h2
            className="flex min-w-0 items-center gap-2 text-base font-semibold outline-none"
            data-teammate-profile-heading
            tabIndex={-1}
          >
            <span className="truncate">{props.name}</span>
            {self ? (
              <span className="shrink-0 text-sm font-normal text-muted-foreground">
                {t('auto.components.billing.team.you', '(you)')}
              </span>
            ) : null}
          </h2>
          <p className="flex min-w-0 items-center gap-2 text-sm text-muted-foreground">
            {props.role ? (
              <Badge variant="outline" className="shrink-0">
                {roleLabel(props.role, t)}
              </Badge>
            ) : null}
            {props.email ? <span className="truncate">{props.email}</span> : null}
          </p>
        </div>
      </header>

      {props.error ? (
        <InlineError
          title={t('auto.components.teammates.loadFailed', 'Couldn’t load this profile')}
          detail={props.error}
          retryLabel={t('auto.components.teammates.tryAgain', 'Try again')}
          onRetry={props.onRetry}
        />
      ) : null}

      <section aria-labelledby="teammate-usage-heading" className="space-y-3">
        <h3 id="teammate-usage-heading" className="text-sm font-medium">
          {t('auto.components.teammates.usageHeading', 'Usage')}
        </h3>
        {profile ? (
          profile.usage ? (
            <TeammateUsageHeatmap usage={profile.usage} self={self} name={props.name} />
          ) : (
            <p className="text-sm text-muted-foreground">
              {t(
                'auto.components.teammates.activityNotShared',
                '{{name}} hasn’t shared their activity.',
                { name: props.name }
              )}
            </p>
          )
        ) : props.error ? null : (
          <UsageSkeleton />
        )}
      </section>

      <section aria-labelledby="teammate-workspaces-heading" className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <h3 id="teammate-workspaces-heading" className="text-sm font-medium">
            {t('auto.components.teammates.recentWorkspaces', 'Recent workspaces')}
          </h3>
          {profile && profile.recentWorkspaces.length > 0 ? (
            <Button variant="ghost" size="xs" onClick={props.onShowAllWorkspaces}>
              {t('auto.components.teammates.showAll', 'Show all')}
            </Button>
          ) : null}
        </div>
        {profile ? (
          profile.recentWorkspaces.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {self
                ? t(
                    'auto.components.teammates.noWorkspacesSelf',
                    'You have no cloud workspaces yet.'
                  )
                : t(
                    'auto.components.teammates.noWorkspaces',
                    'No cloud workspaces shared with the team.'
                  )}
            </p>
          ) : (
            <ul className="-mx-2">
              {profile.recentWorkspaces.map((w) => {
                const status = statusLabel(w, t)
                const title = cloudWorkspaceTitle(w, t)
                const canOpen = w.access !== 'none' && w.archivedAt === null
                return (
                  <li key={w.id}>
                    <button
                      type="button"
                      disabled={!canOpen}
                      onClick={() => props.onOpenWorkspace(w)}
                      aria-label={t(
                        'auto.components.teammates.openWorkspace',
                        'Open {{title}}, {{status}}',
                        { title, status }
                      )}
                      className="group flex w-full min-w-0 cursor-default items-center gap-3 rounded-md px-2 py-1.5 text-left outline-none hover:bg-accent focus-visible:outline-2 focus-visible:outline-solid focus-visible:-outline-offset-2 focus-visible:outline-focus-ring disabled:opacity-60"
                    >
                      <CloudStateDot state={dotState(w)} size="md" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm">{title}</span>
                        <span className="block truncate text-xs text-muted-foreground">
                          {[
                            status,
                            w.repo ? repoLabel(w.repo.url) : null,
                            formatRelative(w.lastActivityAt, props.now, t, locale)
                          ]
                            .filter(Boolean)
                            .join(' · ')}
                        </span>
                      </span>
                      {canOpen ? (
                        <ArrowUpRight
                          aria-hidden
                          className="size-3.5 shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100"
                        />
                      ) : null}
                    </button>
                  </li>
                )
              })}
            </ul>
          )
        ) : props.error ? null : (
          <WorkspacesSkeleton />
        )}
      </section>

      {profile && !self ? (
        <footer className="flex items-center justify-between gap-3 border-t border-border pt-4">
          <p
            className={cn(
              'min-w-0 text-xs',
              props.poke.kind === 'refused' ? 'text-foreground' : 'text-muted-foreground'
            )}
            role="status"
            id={pokeNoteId}
          >
            {footer.note ??
              t(
                'auto.components.teammates.pokeHint',
                'A poke is a friendly nudge. {{name}} sees it in Orca.',
                { name: props.name }
              )}
          </p>
          {footer.turnOn ? (
            <Button variant="outline" size="sm" onClick={props.onTurnOnPokes}>
              {t('auto.components.teammates.openExperimental', 'Open settings')}
            </Button>
          ) : (
            <Tooltip>
              <TooltipTrigger asChild>
                {/* aria-disabled, not disabled: it stays focusable and hoverable so the tooltip can
                    say why it can't poke, with the muted disabled look. */}
                <Button
                  size="sm"
                  variant="outline"
                  aria-disabled={!footer.canPoke || undefined}
                  aria-busy={props.poke.kind === 'sending' || undefined}
                  aria-describedby={footer.canPoke ? undefined : pokeNoteId}
                  onClick={() => {
                    if (footer.canPoke && props.poke.kind !== 'sending') {
                      props.onPoke()
                    }
                  }}
                >
                  <Hand aria-hidden />
                  {t('auto.components.teammates.poke', 'Poke')}
                </Button>
              </TooltipTrigger>
              {!footer.canPoke && footer.note ? (
                <TooltipContent side="top">{footer.note}</TooltipContent>
              ) : null}
            </Tooltip>
          )}
        </footer>
      ) : null}
    </div>
  )
}
