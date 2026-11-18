import React, { useEffect, useId, useState } from 'react'
import { ExternalLink, Loader2, Plus } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useTranslate } from '@/i18n/use-translate'
import { BotHowToAsk } from './BotHowToAsk'
import type { BotConnector } from './bot-connectors'
import { BotAppBrandLogo } from './apps/BotAppBrandLogo'
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

/** One part of a setup screen under its label, e.g. Repositories or Workspace. */
export function ConnectorSetupSection({
  label,
  children
}: {
  label: string
  children: React.ReactNode
}): React.JSX.Element {
  const headingId = useId()
  return (
    <section aria-labelledby={headingId} className="space-y-1.5">
      <h3 id={headingId} className="text-xs font-medium">
        {label}
      </h3>
      {children}
    </section>
  )
}

/** The rows a section lists, e.g. a GitHub install's repositories or the Linear workspace. */
export function ConnectorSetupList({
  items
}: {
  /** `tag`: a short mark after the label, e.g. New. */
  items: readonly { key: string; icon: React.ReactNode; label: React.ReactNode; tag?: string }[]
}): React.JSX.Element {
  return (
    <ul className="divide-y divide-border rounded-lg border border-border">
      {items.map((item) => (
        <li key={item.key} className="flex items-center gap-2.5 px-2.5 py-1.5 text-sm">
          <span className="flex shrink-0 text-muted-foreground">{item.icon}</span>
          <span className="min-w-0 flex-1 break-words">{item.label}</span>
          {item.tag ? <Badge variant="outline">{item.tag}</Badge> : null}
        </li>
      ))}
    </ul>
  )
}

/**
 * Who the trip signed in as, before anything is turned on; "Not you?" follows the last word and
 * starts over with another account. `more` adds without signing out, on the line below.
 */
export function SignedInAs({
  who,
  onNotYou,
  more,
  disabled
}: {
  who: string
  onNotYou: () => void
  more?: ConnectorMore
  disabled?: boolean
}): React.JSX.Element {
  const t = useTranslate()
  const signedIn = (
    <p className="break-words text-sm">
      {t('bots.connect.signedInAs', 'Signed in as {{who}}', { who })}{' '}
      <Button variant="link" size="inlineText" disabled={disabled} onClick={onNotYou}>
        {t('bots.connect.notYou', 'Not you?')}
      </Button>
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
export function ConnectorSetupHeader({
  connector,
  title,
  intro,
  line,
  done = false
}: {
  connector: Pick<BotConnector, 'id' | 'Icon'>
  title: string
  /** Translated, with the text to type in <code>; see BotHowToAsk. */
  intro: string
  /** In place of `intro`, e.g. who signed in. */
  line?: React.ReactNode
  done?: boolean
}): React.JSX.Element {
  return (
    <DialogHeader>
      <div className="flex items-center gap-3 text-left">
        <span aria-hidden className="relative shrink-0">
          <BotAppBrandLogo app={connector} size="lg" />
          {done ? <BotAppLogoBadge kind="done" /> : null}
        </span>
        <div className="min-w-0 flex-1 space-y-0.5 pr-6">
          <DialogTitle>
            <span className="block truncate" title={title}>
              {title}
            </span>
          </DialogTitle>
          <DialogDescription asChild>
            <div className="break-words">{line ?? <BotHowToAsk text={intro} />}</div>
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
