// The one Share dialog every Share opens: the bot as the link shows it, then by the bot's state either
// its contents and Publish link, or its live link, what Update link would send, and Stop sharing.
import { useMemo, useState } from 'react'
import { toast } from 'sonner'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { useTranslate } from '@/i18n/use-translate'
import type { Bot } from '../../../../../shared/bot-types'
import { BOT_SHARE_ERRORS } from '../../../../../shared/bots/bot-share-errors'
import { useOrcaCloudSignedOut } from '../orca-cloud-signed-out'
import { botShareFlagPage, botShareFlagSpot, type BotShareFlagSpot } from './bot-share-flags'
import { openBotHomeFileAtLine } from './bot-share-go-to-line'
import type { BotShareContext, BotSharePage } from './bot-share-pages'
import { publishBotShare, settleBotShare, stopBotShare, updateBotShare } from './bot-share-rpc'
import {
  BotShareDrillIn,
  BotShareHero,
  BotShareLinkBlock,
  BotShareOfflineRow,
  BotShareSecretNotice,
  BotShareUpdatedLine
} from './BotShareDialog'
import { BODY, Contents, Footer, type Phase } from './BotShareFooter'
import { pageTitle } from './BotShareOverview'
import { useBotShareCandidate } from './use-bot-share-candidate'
import type { BotShareCandidateSummary } from '../../../../../shared/bots/bot-package'
import { useBotShareLink, type BotShareLink, type BotShareStart } from './use-bot-share-link'

type BotShareFlowProps = {
  bot: Bot
  start?: BotShareStart
  onClose: () => void
  onChanged?: () => void
}

export function BotShareFlow({
  link,
  shareId,
  ...props
}: BotShareFlowProps & { link?: BotShareLink | null; shareId?: string }): React.JSX.Element {
  const signedOut = useOrcaCloudSignedOut()
  const linkState = useBotShareLink(props.bot.id, link, signedOut, shareId)
  return <BotSharePreview {...props} linkState={linkState} />
}

export function BotSharePreview({
  bot,
  start = 'open',
  linkState,
  onClose,
  onChanged
}: BotShareFlowProps & { linkState: ReturnType<typeof useBotShareLink> }): React.JSX.Element {
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        size="flush"
        showCloseButton={false}
        className="grid max-h-[calc(100vh-3rem)] grid-rows-[minmax(0,1fr)_auto] overflow-hidden sm:max-w-[520px]"
      >
        <ShareBody
          bot={bot}
          start={start}
          linkState={linkState}
          onClose={onClose}
          onChanged={onChanged}
        />
      </DialogContent>
    </Dialog>
  )
}

/** When a publish just landed; the link's own time arrives on the next read. */
function justNow(): string {
  return new Date().toISOString()
}

/** The note as a link carries it, near enough to compare with the candidate's. */
function noteOf(note: string): string {
  return note.trim()
}

function ShareBody({
  bot,
  start,
  linkState,
  onClose,
  onChanged
}: {
  bot: Bot
  start: BotShareStart
  linkState: ReturnType<typeof useBotShareLink>
  onClose: () => void
  onChanged?: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const { read, setLink, reread } = linkState
  const link = read.kind === 'read' ? read.link : null
  // A bot with a live link starts from what it was last published with; one without starts from the
  // defaults (memory off), whatever an older link left behind.
  const state = useBotShareCandidate(
    bot,
    read.kind === 'read' ? (link ? 'last' : 'defaults') : 'local'
  )
  const { candidate } = state
  const [phase, setPhase] = useState<Phase>(
    start === 'stop' ? { kind: 'confirmStop' } : { kind: 'idle' }
  )
  const [error, setError] = useState<{ message: string; moved: boolean } | null>(null)
  const [nav, setNav] = useState<BotSharePage[]>([])

  const spots = useMemo(
    () => (candidate ? candidate.flags.map((flag) => botShareFlagSpot(flag, candidate)) : []),
    [candidate]
  )
  const secret = spots.find((spot) => spot.flag.kind === 'secret') ?? null
  const open = (page: BotSharePage): void => setNav((current) => [...current, page])
  const goToLine = (spot: BotShareFlagSpot): void => {
    if (spot.homePath && spot.flag.line !== null) {
      if (openBotHomeFileAtLine(bot, spot.homePath, spot.flag.line)) {
        onClose()
      } else {
        toast.error(t('bots.share.openFailed', 'Orca could not open this file.'))
      }
    }
  }
  const upToDate =
    link && candidate && state.committed && link.digest !== null
      ? candidate.botDigest === link.digest &&
        noteOf(state.note) === (candidate.bot.setupNote ?? '')
      : null

  const copy = async (url: string, quiet = false): Promise<void> => {
    await window.api.ui.writeClipboardText(url)
    if (!quiet) {
      toast.success(t('bots.share.linkCopied', 'Link copied'))
    }
  }

  const publish = async (
    retried = false,
    shown: BotShareCandidateSummary | null = candidate
  ): Promise<void> => {
    if (!shown) {
      return
    }
    setPhase({ kind: 'busy' })
    setError(null)
    const result = await settleBotShare(
      link
        ? updateBotShare(bot, shown.candidateId, state.note, {
            shareId: link.shareId,
            expectedVersionId: link.versionId
          })
        : publishBotShare(bot, shown.candidateId, state.note)
    )
    if (!result.ok) {
      // An expired preview, or a package made meanwhile: build again from the same picks, once.
      if (
        !retried &&
        (result.code === BOT_SHARE_ERRORS.expired || result.code === BOT_SHARE_ERRORS.prepareAgain)
      ) {
        const rebuilt = await state.select({}, shown.bot.setupNote ?? '')
        if (rebuilt) {
          if (rebuilt.botDigest !== shown.botDigest) {
            setPhase({ kind: 'idle' })
            setError({
              message: t(
                'bots.share.previewChanged',
                'The preview changed. Review it before publishing.'
              ),
              moved: false
            })
            return
          }
          return publish(true, rebuilt)
        }
      }
      setPhase({ kind: 'idle' })
      const moved = result.code === BOT_SHARE_ERRORS.moved
      setError({
        // Reload here does what the shipped line asks (open Share bot again).
        message: moved
          ? t('bots.share.movedHere', 'This link was updated somewhere else.')
          : result.error,
        moved
      })
      return
    }
    const { share, version } = result.value
    const first = !link
    setLink({
      shareId: share.id,
      url: share.url,
      versionId: share.pinnedVersionId,
      updatedAt: justNow(),
      digest: version.packageDigest
    })
    onChanged?.()
    setNav([])
    // The first link goes on the clipboard: sending it is the only thing left to do.
    if (first) {
      await copy(share.url, true)
    }
    setPhase({ kind: 'done', updated: !first, copied: first })
  }

  const stop = async (): Promise<void> => {
    if (!link) {
      return
    }
    setPhase({ kind: 'stopping' })
    setError(null)
    const result = await settleBotShare(stopBotShare(link.shareId, bot.id))
    if (!result.ok) {
      setPhase({ kind: 'confirmStop' })
      setError({ message: result.error, moved: false })
      return
    }
    toast.success(t('bots.share.stopped', 'Stopped sharing {{name}}', { name: bot.name }))
    onChanged?.()
    if (start === 'stop') {
      onClose()
      return
    }
    setLink(null)
    setPhase({ kind: 'idle' })
  }

  const ctx: BotShareContext | null = candidate
    ? {
        bot,
        candidate,
        selection: state.selection,
        committed: state.committed,
        select: (change) => void state.select(change),
        spots,
        open,
        goToLine,
        note: state.note,
        setNote: state.setNote
      }
    : null
  const page = nav.at(-1)
  if (page && ctx) {
    return (
      <>
        <div className={BODY}>
          <BotShareDrillIn
            // Each page mounts fresh, so it takes focus as it opens.
            key={nav.length}
            page={page}
            ctx={ctx}
            backLabel={nav.length > 1 ? pageTitle(nav.at(-2)!, t) : bot.name}
            onBack={() => setNav((current) => current.slice(0, -1))}
          />
        </div>
        <Footer
          {...{ bot, state, read, link, phase, error, secret, upToDate, start }}
          onPublish={() => void publish()}
          onStop={() => void stop()}
          setPhase={setPhase}
          onReload={() => {
            setError(null)
            reread()
          }}
          onClose={onClose}
        />
      </>
    )
  }

  const done = phase.kind === 'done'
  return (
    <>
      <div className={BODY}>
        <BotShareHero
          bot={bot}
          purpose={candidate ? candidate.bot.purpose : state.error ? null : undefined}
          compact={Boolean(link) && !done}
        />
        {read.kind === 'loading' ? (
          <BotShareLinkBlock url={null} copied={false} meta={null} onCopy={() => {}} />
        ) : read.kind === 'offline' ? (
          <BotShareOfflineRow error={read.error} onRetry={reread} />
        ) : link ? (
          <BotShareLinkBlock
            url={link.url}
            copied={done && phase.copied}
            onCopy={() => void copy(link.url)}
            meta={
              done ? (
                phase.updated ? (
                  t('bots.share.updatedJustNow', 'Updated just now')
                ) : (
                  <>
                    {t('bots.share.publishedJustNow', 'Published just now')}
                    <span aria-hidden className="opacity-60">
                      ·
                    </span>
                    {t('bots.share.description', 'Anyone with the link can make a copy.')}
                  </>
                )
              ) : (
                <BotShareUpdatedLine updatedAt={link.updatedAt} upToDate={upToDate} />
              )
            }
          />
        ) : null}
        {done ? null : (
          <>
            {secret ? (
              <BotShareSecretNotice
                spot={secret}
                onView={
                  botShareFlagPage(secret)
                    ? () => {
                        const target = botShareFlagPage(secret)
                        if (target) {
                          open(target)
                        }
                      }
                    : null
                }
                onGoToLine={
                  secret.homePath && secret.flag.line !== null ? () => goToLine(secret) : null
                }
              />
            ) : null}
            <Contents state={state} ctx={ctx} shared={Boolean(link)} />
          </>
        )}
      </div>
      <Footer
        {...{ bot, state, read, link, phase, error, secret, upToDate, start }}
        onPublish={() => void publish()}
        onStop={() => void stop()}
        setPhase={setPhase}
        onReload={() => {
          setError(null)
          reread()
        }}
        onClose={onClose}
      />
    </>
  )
}
