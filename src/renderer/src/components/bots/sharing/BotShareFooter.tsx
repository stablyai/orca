import { Loader2, RefreshCw, Share2 } from 'lucide-react'
import { OrcaSignInWaitNotice } from '@/components/orca-profiles/OrcaSignInProgress'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import type { Bot } from '../../../../../shared/bot-types'
import { OrcaCloudSignInButton } from '../orca-cloud-sign-in'
import { SettingsInsetGroup } from '../settings-view/BotSettingsRows'
import type { BotShareFlagSpot } from '../../../../../shared/bots/bot-share-flag-spots'
import type { BotShareContext } from './bot-share-pages'
import { BotShareOverview, BotShareOverviewSkeleton } from './BotShareOverview'
import type { BotShareCandidateState } from './use-bot-share-candidate'
import type { BotShareLink, BotShareStart, LinkRead } from './use-bot-share-link'

export const BODY = 'scrollbar-sleek flex min-h-0 flex-col gap-4 overflow-y-auto px-6 pt-6'
export const FOOT = 'mt-5 flex items-center gap-2 border-t border-border px-6 py-4'

export type Phase =
  | { kind: 'idle' }
  | { kind: 'busy' }
  | { kind: 'done'; updated: boolean; copied: boolean }
  | { kind: 'confirmStop' }
  | { kind: 'stopping' }

export function Contents({
  state,
  ctx,
  shared
}: {
  state: BotShareCandidateState
  ctx: BotShareContext | null
  shared: boolean
}): React.JSX.Element {
  const t = useTranslate()
  const failure = state.error ? (
    <SettingsInsetGroup>
      <div className="flex min-h-11 items-center gap-2.5 py-2 pr-2.5 pl-3 text-sm">
        <span className="min-w-0 flex-1 text-destructive">{state.error}</span>
        <Button type="button" variant="outline" size="sm" onClick={state.rebuild}>
          {t('settings.bots.retry', 'Retry')}
        </Button>
      </div>
    </SettingsInsetGroup>
  ) : null
  const rows = ctx ? (
    <>
      {failure}
      <BotShareOverview ctx={ctx} />
    </>
  ) : (
    (failure ?? <BotShareOverviewSkeleton />)
  )
  if (!shared) {
    return rows
  }
  return (
    <section className="flex flex-col gap-1.5">
      <h3 className="px-3 text-xs font-medium text-muted-foreground">
        {t('bots.share.nextUpdate', 'Next update')}
      </h3>
      <div className="flex flex-col gap-4">{rows}</div>
      <p className="px-3 text-xs leading-4 text-muted-foreground">
        {t('bots.share.sameLink', 'Goes to the same link. Copies already made stay as they are.')}
      </p>
    </section>
  )
}

export function Footer({
  bot,
  state,
  read,
  link,
  phase,
  error,
  secret,
  upToDate,
  start,
  onPublish,
  onStop,
  setPhase,
  onReload,
  onClose
}: {
  bot: Bot
  state: BotShareCandidateState
  read: LinkRead
  link: BotShareLink | null
  phase: Phase
  error: { message: string; moved: boolean } | null
  secret: BotShareFlagSpot | null
  upToDate: boolean | null
  start: BotShareStart
  onPublish: () => void
  onStop: () => void
  setPhase: (phase: Phase) => void
  onReload: () => void
  onClose: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const busy = phase.kind === 'busy'
  const needsSignIn = read.kind === 'signIn'
  const foot = cn(FOOT, needsSignIn && 'flex-wrap')
  const signInNotice = needsSignIn && (
    <OrcaSignInWaitNotice
      className="basis-full"
      cancelLabel={t('bots.share.cancelSignIn', 'Cancel sign-in')}
    />
  )
  if (phase.kind === 'confirmStop' || phase.kind === 'stopping') {
    return (
      <div className={foot}>
        {signInNotice}
        <span
          className={cn(
            'min-w-0 flex-1 text-xs leading-4',
            error ? 'text-destructive' : 'text-muted-foreground'
          )}
        >
          {error ? (
            error.message
          ) : (
            <>
              <span className="font-medium text-foreground">
                {t('bots.share.stopTitle', 'Stop sharing {{name}}?', { name: bot.name })}
              </span>{' '}
              {t('bots.share.stopDescription', 'The link stops working.')}
            </>
          )}
        </span>
        <Button
          type="button"
          variant="outline"
          disabled={phase.kind === 'stopping'}
          onClick={() => (start === 'stop' ? onClose() : setPhase({ kind: 'idle' }))}
        >
          {t('bots.share.cancel', 'Cancel')}
        </Button>
        {needsSignIn ? (
          <OrcaCloudSignInButton onSignedIn={onReload} />
        ) : (
          <Button
            type="button"
            variant="destructive"
            disabled={phase.kind === 'stopping' || !link}
            onClick={onStop}
          >
            {phase.kind === 'stopping' ? <Loader2 className="animate-spin" /> : null}
            {t('bots.share.stopSharing', 'Stop sharing')}
          </Button>
        )}
      </div>
    )
  }
  if (phase.kind === 'done') {
    return (
      <div className={FOOT}>
        <span className="flex-1" />
        <Button type="button" autoFocus onClick={onClose}>
          {t('bots.share.done', 'Done')}
        </Button>
      </div>
    )
  }
  const { candidate } = state
  const message = secret ? (
    <span className="min-w-0 flex-1 text-xs leading-4 text-destructive">
      {t('bots.share.removeSecret', 'Remove the secret to publish')}
    </span>
  ) : error || state.error ? (
    <span className="min-w-0 flex-1 text-xs leading-4 text-destructive" role="alert">
      {error?.message ?? state.error}
    </span>
  ) : (
    // Its whole width or a line of its own: the hint never cuts off beside the buttons.
    <span className="min-w-0 grow basis-[max-content] text-xs leading-4 text-muted-foreground">
      {link || read.kind === 'loading'
        ? null
        : t('bots.share.description', 'Anyone with the link can make a copy.')}
    </span>
  )
  const off = !candidate || candidate.blocked || !state.committed || busy
  let second: React.ReactNode
  let primary: React.ReactNode
  if (read.kind === 'loading') {
    second = (
      <Button type="button" variant="outline" onClick={onClose}>
        {t('bots.share.cancel', 'Cancel')}
      </Button>
    )
    primary = <Button type="button" disabled className="w-32" aria-hidden />
  } else if (link) {
    if (error?.moved) {
      primary = (
        <Button type="button" onClick={onReload}>
          <RefreshCw />
          {t('bots.share.reload', 'Reload')}
        </Button>
      )
    } else if (upToDate) {
      second = (
        <Button type="button" variant="outline" disabled>
          <RefreshCw />
          {t('bots.share.updateLink', 'Update link')}
        </Button>
      )
      primary = (
        <Button type="button" onClick={onClose}>
          {t('bots.share.done', 'Done')}
        </Button>
      )
    } else {
      second = (
        <Button type="button" variant="outline" disabled={busy} onClick={onClose}>
          {t('bots.share.done', 'Done')}
        </Button>
      )
      primary = (
        <Button type="button" disabled={off} onClick={onPublish}>
          {busy ? <Loader2 className="animate-spin" /> : <RefreshCw />}
          {busy ? t('bots.share.updating', 'Updating…') : t('bots.share.updateLink', 'Update link')}
        </Button>
      )
    }
  } else {
    second = (
      <Button type="button" variant="outline" disabled={busy} onClick={onClose}>
        {t('bots.share.cancel', 'Cancel')}
      </Button>
    )
    primary = needsSignIn ? (
      <OrcaCloudSignInButton disabled={busy} onSignedIn={onReload}>
        <Share2 />
        {t('bots.share.signInToPublish', 'Sign in to publish')}
      </OrcaCloudSignInButton>
    ) : (
      <Button type="button" disabled={off || read.kind !== 'read'} onClick={onPublish}>
        {busy ? <Loader2 className="animate-spin" /> : <Share2 />}
        {busy
          ? t('bots.share.publishing', 'Publishing…')
          : t('bots.share.publishLink', 'Publish link')}
      </Button>
    )
  }
  return (
    <div className={cn(FOOT, 'flex-wrap')}>
      {signInNotice}
      {link && !error ? (
        <Button
          type="button"
          variant="ghost-destructive"
          className="-ml-2.5"
          disabled={busy}
          onClick={() => setPhase({ kind: 'confirmStop' })}
        >
          {t('bots.share.stopSharing', 'Stop sharing')}
        </Button>
      ) : null}
      {message}
      <div className="ml-auto flex shrink-0 items-center gap-2">
        {second}
        {primary}
      </div>
    </div>
  )
}
