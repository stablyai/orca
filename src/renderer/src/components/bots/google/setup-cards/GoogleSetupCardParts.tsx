import React from 'react'
import { Check, ChevronRight } from 'lucide-react'
import { Trans } from 'react-i18next'
import { GoogleIcon } from '@/components/icons/GoogleIcon'
import { Button } from '@/components/ui/button'
import { i18n } from '@/i18n/i18n'
import { useTranslate } from '@/i18n/use-translate'
import {
  NativeChatCardAvatar,
  NativeChatCardFrame
} from '@/components/native-chat/NativeChatCardFrame'
import type { GoogleSetupRun } from '../../../../../../shared/google/google-setup-run'

/** A setup card's frame: the Google mark, a heading, an optional right-hand state, title and action bar. */
export function GoogleSetupCardFrame({
  heading,
  trailing,
  title,
  footer,
  children
}: {
  heading: string
  trailing?: React.ReactNode
  title?: React.ReactNode
  footer?: React.ReactNode
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <NativeChatCardFrame
      avatar={
        <NativeChatCardAvatar>
          <GoogleIcon className="size-4" />
        </NativeChatCardAvatar>
      }
      heading={heading}
      trailing={trailing}
      title={title}
      footer={footer}
    >
      {children}
    </NativeChatCardFrame>
  )
}

/** The line under an answered card, in place of a chat bubble: what was chosen, and Change. */
export function GoogleSetupReceipt({
  text,
  onChange
}: {
  text: string
  onChange?: () => void
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <div className="mt-1 flex justify-end gap-1 text-xs text-chat-foreground-faint">
      <span>{text}</span>
      {onChange ? (
        <>
          <span aria-hidden>·</span>
          <Button variant="link" size="inlineText" onClick={onChange}>
            {t('bots.googleSetup.receipt.change', 'Change')}
          </Button>
        </>
      ) : null}
    </div>
  )
}

/** One option on a choice card. Once answered, the chosen row stays and the others dim. */
export function GoogleSetupChoiceRow({
  title,
  note,
  leading,
  chosen,
  locked,
  onChoose
}: {
  title: string
  note?: string
  leading?: React.ReactNode
  chosen: boolean
  locked: boolean
  onChoose: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      disabled={locked}
      data-chosen={chosen}
      onClick={onChoose}
      className="flex w-full items-center gap-3 rounded-md border border-border p-3 text-left outline-none hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-default disabled:opacity-50 disabled:hover:bg-transparent data-[chosen=true]:border-input data-[chosen=true]:disabled:opacity-100"
    >
      {leading}
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-sm font-medium text-foreground">{title}</span>
        {note ? <span className="text-xs text-muted-foreground">{note}</span> : null}
      </span>
      {chosen ? (
        <Check className="size-4 shrink-0 text-foreground" aria-hidden />
      ) : (
        <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      )}
    </button>
  )
}

/** A choice made before the bot started in Google Cloud can still change; after, it says so in chat. */
export function googleSetupChoiceChangeable(run: GoogleSetupRun): boolean {
  return run.state === 'running' && (run.steps.project?.status ?? 'pending') === 'pending'
}

/** What to do on a step, one numbered line each, with its key words in bold. */
export function GoogleSetupStepNotes({ notes }: { notes: readonly string[] }): React.JSX.Element {
  return (
    <ol className="mt-1 list-decimal space-y-0.5 pl-4 text-xs text-muted-foreground">
      {notes.map((note) => (
        <li key={note}>
          <Trans
            i18n={i18n}
            defaults={note}
            components={{ b: <strong className="font-medium text-foreground" /> }}
          />
        </li>
      ))}
    </ol>
  )
}
