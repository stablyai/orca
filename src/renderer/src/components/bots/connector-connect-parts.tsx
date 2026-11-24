import React, { useEffect, useState } from 'react'
import { ExternalLink, Loader2, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { translate } from '@/i18n/i18n'
import { useTranslate } from '@/i18n/use-translate'
import { BotHowToAsk, HOW_TO_ASK_ESCAPED } from './BotHowToAsk'
import type { BotConnector } from './bot-connectors'
import { BotAppBrandLogo, BotAppBrandMark } from './apps/BotAppBrandLogo'
import { BotAppLogoBadge } from './apps/BotAppStepParts'

/** How long a trip waits before its `help` shows: past a normal sign-in, short of the trip's expiry. */
export const CONNECT_HELP_AFTER_MS = 30_000

/** The trip is in the browser: what to finish there, and a way to stop waiting (or `action` instead). */
export function ConnectWaiting({
  label,
  onCancel,
  action,
  help
}: {
  label: string
  /** Shown once the trip has waited CONNECT_HELP_AFTER_MS, for a browser page that never returns. */
  help?: string
} & (
  | { onCancel: () => void; action?: undefined }
  | { onCancel?: undefined; action: React.ReactNode }
)): React.JSX.Element {
  const t = useTranslate()
  const [late, setLate] = useState(false)
  useEffect(() => {
    if (!help) {
      return undefined
    }
    const timer = setTimeout(() => setLate(true), CONNECT_HELP_AFTER_MS)
    return () => clearTimeout(timer)
  }, [help])
  const waiting = (
    <div className="flex items-center gap-3">
      <p
        role="status"
        className="flex min-w-0 flex-1 items-center gap-2 text-sm text-muted-foreground"
      >
        <Loader2 className="size-4 shrink-0 animate-spin" />
        {label}
      </p>
      {action ?? (
        <Button size="sm" variant="ghost" onClick={onCancel}>
          {t('bots.connect.cancel', 'Cancel')}
        </Button>
      )}
    </div>
  )
  return late && help ? (
    <div className="space-y-2">
      {waiting}
      <p className="text-sm text-muted-foreground">{help}</p>
    </div>
  ) : (
    waiting
  )
}

/** A link that opens the browser to add more of a service, e.g. another workspace. */
export type ConnectorMore = { label: string; onClick: () => void }

export function ConnectorMoreLink({ more }: { more: ConnectorMore }): React.JSX.Element {
  return (
    <Button variant="ghost" size="xs" className="-ml-2" onClick={more.onClick}>
      <Plus />
      {more.label}
      <ExternalLink />
    </Button>
  )
}

/**
 * Who the trip signed in as, before anything is turned on; "Not you?" follows the last word and
 * starts over with another account (none when several are linked, as each is the owner). `more`
 * adds without signing out, on the line below.
 */
export function SignedInAs({
  who,
  onNotYou,
  more,
  disabled
}: {
  who: string
  onNotYou: (() => void) | null
  more?: ConnectorMore
  disabled?: boolean
}): React.JSX.Element {
  const t = useTranslate()
  const signedIn = (
    <p className="break-words text-sm">
      {t('bots.connect.signedInAs', 'Signed in as {{who}}', { who })}
      {onNotYou ? (
        <>
          {' '}
          <Button variant="link" size="inlineText" disabled={disabled} onClick={onNotYou}>
            {t('bots.connect.notYou', 'Not you?')}
          </Button>
        </>
      ) : null}
    </p>
  )
  return more ? (
    <div className="space-y-1.5">
      {signedIn}
      <ConnectorMoreLink more={more} />
    </div>
  ) : (
    signedIn
  )
}

/** One row per workspace to pick, and a way to add one not listed. */
export function ConnectorWorkspacePicker({
  prompt,
  workspaces,
  another
}: {
  prompt: string
  workspaces: { key: string; icon: React.ReactNode; label: React.ReactNode; onPick: () => void }[]
  another: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">{prompt}</p>
      <div className="-mx-3 flex flex-col gap-0.5">
        {workspaces.map((workspace) => (
          <Button
            key={workspace.key}
            variant="ghost"
            className="justify-start"
            onClick={workspace.onPick}
          >
            {workspace.icon}
            {workspace.label}
          </Button>
        ))}
      </div>
      <DialogFooter>{another}</DialogFooter>
    </div>
  )
}

/**
 * A connector setup dialog's header: the service's mark on its tile (checked once the bot is on),
 * the title, and one line: what turning it on does, or who signed in.
 */
/** A setup header's line under "Connect <service>": which bot, and on which host. */
export function connectorSetupFor(bot: { name: string }, hostName: string | null): string {
  return hostName
    ? translate('bots.setup.forOnHost', 'for {{name}} on {{host}}', {
        name: bot.name,
        host: hostName,
        ...HOW_TO_ASK_ESCAPED
      })
    : translate('bots.setup.for', 'for {{name}}', { name: bot.name, ...HOW_TO_ASK_ESCAPED })
}

const INTRO_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  '#39': "'",
  '#x2F': '/'
}

/** An escaped intro (see HOW_TO_ASK_ESCAPED) as plain text, for a tooltip. */
function plainIntro(intro: string): string {
  return intro
    .replace(/<[^>]*>/g, '')
    .replace(/&(amp|lt|gt|quot|#39|#x2F);/g, (_, entity: string) => INTRO_ENTITIES[entity])
}

export function ConnectorSetupHeader({
  connector,
  title,
  intro,
  line,
  done = false,
  bare = false,
  corner
}: {
  connector: Pick<BotConnector, 'id' | 'Icon'>
  title: string
  /** Translated, with the text to type in <code>; see BotHowToAsk. */
  intro: string
  /** In place of `intro`, e.g. who signed in. */
  line?: React.ReactNode
  done?: boolean
  /** The mark alone, with no tile, and a 12px line under the title. */
  bare?: boolean
  /** In place of the dialog's own corner button, centered on the title's line. */
  corner?: React.ReactNode
}): React.JSX.Element {
  return (
    <DialogHeader>
      <div
        className={
          bare ? 'flex items-center gap-1.5 text-left' : 'flex items-center gap-3 text-left'
        }
      >
        <span aria-hidden className="relative shrink-0">
          {bare ? (
            <span className="flex size-8 items-center justify-center">
              <BotAppBrandMark id={connector.id} className="size-6" />
            </span>
          ) : (
            <BotAppBrandLogo app={connector} size="lg" />
          )}
          {done ? <BotAppLogoBadge kind="done" size={bare ? 'sm' : 'md'} /> : null}
        </span>
        <div className={corner ? 'min-w-0 flex-1 space-y-0.5' : 'min-w-0 flex-1 space-y-0.5 pr-6'}>
          <div className="flex min-w-0 items-center gap-2">
            <div className="min-w-0 flex-1">
              <DialogTitle>
                <span className="block truncate" title={title}>
                  {title}
                </span>
              </DialogTitle>
            </div>
            {corner}
          </div>
          <DialogDescription asChild size={bare ? 'compact' : 'default'}>
            {/* Compact: one line; a long intro ends in … with the whole of it as the tooltip. */}
            <div
              className={bare ? (line ? 'min-w-0' : 'min-w-0 truncate') : 'break-words'}
              title={bare && !line && intro ? plainIntro(intro) : undefined}
            >
              {line ?? (intro ? <BotHowToAsk text={intro} /> : null)}
            </div>
          </DialogDescription>
        </div>
      </div>
    </DialogHeader>
  )
}

/** `read()` as it was when the dialog last opened, so the dialog's own change doesn't retitle it mid-flow. */
export function useReadOnOpen<T>(open: boolean, read: () => T): T {
  const [at, setAt] = useState(() => ({ open, value: read() }))
  if (at.open !== open) {
    const next = { open, value: open ? read() : at.value }
    setAt(next)
    return next.value
  }
  return at.value
}
