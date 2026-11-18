// The live step list, and the card for a step the person does. Neither posts a chat message: Done,
// "Take over from here" and "Let me do this one" are card answers the bot reads.
import React, { useCallback, useState } from 'react'
import { Check, ExternalLink, LoaderCircle } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import { botTarget, type BotRef, useStableBotRef } from '@/lib/bot-hosts'
import {
  currentGoogleSetupStep,
  GOOGLE_SETUP_STEPS,
  googleSetupAwaitsKey,
  personDoesGoogleSetupStep,
  type GoogleSetupRun,
  type GoogleSetupStep
} from '../../../../../../shared/google/google-setup-run'
import { GoogleBrandingLinks } from '../GoogleBrandingLinks'
import { googleConsoleStepUrl } from '../../../../../../shared/google/google-console-setup'
import { importGoogleApp, openInMyBrowser } from '../google-connect-client'
import { googleKeyRefusalHeadline, googleStepNotes } from '../google-copy'
import { useGoogleClientFile } from '../use-google-client-file'
import { GoogleSetupBlockerPanel } from './GoogleSetupBlockerPanel'
import { googleSetupBlockerIsConnect } from './google-setup-blocker-copy'
import { useCaptureClientKey, type KeySource } from '../use-capture-google-key'
import {
  GoogleSetupCardFrame,
  GoogleSetupReceipt,
  GoogleSetupStepNotes,
  googleSetupChoiceChangeable
} from './GoogleSetupCardParts'
import { googleSetupStepTitle } from './google-setup-card-copy'
import { answerGoogleSetup, useGoogleSetupBlocker } from './google-setup-run-store'

function keySource(run: GoogleSetupRun, armed: boolean): KeySource {
  // Orca's browser hands the key to main as it downloads; only the person's own browser needs a watch.
  return armed && run.mode === 'guide-browser' && googleSetupAwaitsKey(run)
    ? { kind: 'downloads' }
    : null
}

async function saveKey(bot: BotRef, text: string): Promise<void> {
  await importGoogleApp(botTarget(bot), text).catch((error: unknown) => {
    throw new Error(
      googleKeyRefusalHeadline(error instanceof Error ? error.message : String(error))
    )
  })
  await answerGoogleSetup(bot, 'step', ['done', 'client'])
}

/** Saves the app key the moment it lands in Downloads, from the person's own browser. */
function useSetupKeyCapture(
  bot: BotRef,
  run: GoogleSetupRun,
  owns: boolean
): { owns: boolean; error: string | null } {
  const ref = useStableBotRef(bot)
  const onClient = useCallback((text: string) => saveKey(ref, text), [ref])
  return { owns, error: useCaptureClientKey(keySource(run, owns), onClient).error }
}

/** For a key Orca didn't pick up (saved elsewhere, or the download went missed): import it by hand. */
function KeyImport({ bot }: { bot: BotRef }): React.JSX.Element {
  const t = useTranslate()
  const file = useGoogleClientFile((text) => saveKey(bot, text))
  return (
    <div className="mt-2 text-xs text-muted-foreground">
      {t('bots.googleSetup.keyMissed', 'Downloaded the key and Orca didn’t pick it up?')}{' '}
      <Button
        variant="link"
        size="inlineText"
        disabled={file.busy}
        onClick={() => void file.pick()}
      >
        {t('bots.google.importSetupFile', 'Import file')}
      </Button>
      {file.error ? (
        <p role="alert" className="mt-1 text-destructive">
          {file.error}
        </p>
      ) : null}
    </div>
  )
}

function answerAccount(bot: BotRef, values: string[]): void {
  void answerGoogleSetup(bot, 'account', values).catch((error: unknown) =>
    toast.error(error instanceof Error ? error.message : String(error))
  )
}

function answerStep(bot: BotRef, values: string[]): void {
  void answerGoogleSetup(bot, 'step', values).catch((error: unknown) =>
    toast.error(error instanceof Error ? error.message : String(error))
  )
}

function StepMark({ index, status }: { index: number; status: string }): React.JSX.Element {
  return (
    <span
      data-status={status}
      className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border border-border text-2xs font-semibold text-muted-foreground tabular-nums data-[status=active]:border-foreground data-[status=done]:border-transparent data-[status=done]:bg-foreground data-[status=done]:text-background data-[status=needs-user]:border-chat-warning data-[status=needs-user]:text-chat-warning"
    >
      {status === 'done' ? <Check className="size-3" /> : index + 1}
    </span>
  )
}

export function GoogleSetupProgressCard({
  bot,
  botName,
  run,
  newest
}: {
  bot: BotRef
  botName: string
  run: GoogleSetupRun
  /** Only the newest copy in the chat acts: it waits for the key and shows the buttons. */
  newest: boolean
}): React.JSX.Element {
  const t = useTranslate()
  const capture = useSetupKeyCapture(bot, run, newest)
  const blocker = useGoogleSetupBlocker(bot)
  const clientStatus = run.steps.client?.status
  // Before client is done, a missed key's recovery (Make a new key, Import a key file) shows here;
  // the sign-in card takes over the key's blockers after.
  const panel =
    capture.owns &&
    blocker &&
    (blocker.kind === 'stopped' ||
      blocker.kind === 'paused' ||
      (googleSetupAwaitsKey(run) && googleSetupBlockerIsConnect(blocker)))
      ? blocker
      : null
  const keyImport =
    capture.owns &&
    !panel &&
    googleSetupAwaitsKey(run) &&
    (clientStatus === 'active' || clientStatus === 'needs-user')
  const services = run.services ?? []
  const current = currentGoogleSetupStep(run)
  const shown = GOOGLE_SETUP_STEPS.filter((step) => run.steps[step]?.status !== 'skipped')
  // The sign-in at the end is always the owner's, on its own card.
  const waiting =
    current === 'connect' || shown.some((step) => run.steps[step]?.status === 'needs-user')
  const working = t('bots.googleSetup.progress.working', 'Working')
  const state =
    run.state === 'done'
      ? t('bots.googleSetup.progress.done', 'Done')
      : waiting
        ? t('bots.googleSetup.progress.waiting', 'Waiting for you')
        : run.state === 'running'
          ? working
          : null
  // One signed-in account is used without asking; this switches it before the bot starts in Google Cloud.
  const otherAccount =
    newest &&
    run.steps.account?.status === 'done' &&
    (run.accounts?.length ?? 0) <= 1 &&
    googleSetupChoiceChangeable(run)
  const botDoing =
    newest &&
    run.state === 'running' &&
    current !== null &&
    current !== 'connect' &&
    run.steps[current]?.status !== 'needs-user' &&
    !personDoesGoogleSetupStep(run, current)
  return (
    <GoogleSetupCardFrame
      heading={t('bots.googleSetup.progress.heading', 'Setting up Google')}
      trailing={
        state ? (
          <span className="inline-flex items-center gap-1">
            {state === working ? (
              <LoaderCircle className="size-3 animate-spin" aria-hidden />
            ) : null}
            {state}
          </span>
        ) : null
      }
    >
      <ol className="mt-1 space-y-1.5">
        {shown.map((step, index) => {
          const entry = run.steps[step]
          const status = entry?.status ?? 'pending'
          const who =
            status === 'done'
              ? entry?.by === 'user'
                ? t('bots.googleSetup.progress.you', 'You')
                : botName
              : null
          const note = entry?.note ?? who
          return (
            <li key={step} data-status={status} className="flex gap-2.5">
              <StepMark index={index} status={status} />
              <div className="min-w-0">
                <div
                  data-status={status}
                  className="text-sm text-foreground data-[status=pending]:text-muted-foreground"
                >
                  {googleSetupStepTitle(step, services)}
                </div>
                {note ? (
                  <div
                    data-status={status}
                    className="text-xs text-muted-foreground data-[status=needs-user]:text-chat-warning"
                  >
                    {note}
                  </div>
                ) : null}
                {step === 'account' && otherAccount ? (
                  <Button
                    variant="link"
                    size="inlineText"
                    onClick={() => answerAccount(bot, ['other'])}
                  >
                    {t('bots.googleSetup.otherAccount', 'Use a different account')}
                  </Button>
                ) : null}
              </div>
            </li>
          )
        })}
      </ol>
      {capture.error ? (
        <p role="alert" className="mt-2 text-xs text-destructive">
          {capture.error}
        </p>
      ) : null}
      {keyImport ? <KeyImport bot={bot} /> : null}
      {panel ? <GoogleSetupBlockerPanel bot={bot} run={run} blocker={panel} /> : null}
      {botDoing && current ? (
        <div className="mt-2">
          <Button
            variant="link"
            size="inlineText"
            onClick={() => answerStep(bot, ['let-me', current])}
          >
            {t('bots.googleSetup.letMe', 'Let me do this one')}
          </Button>
        </div>
      ) : null}
    </GoogleSetupCardFrame>
  )
}

/** The console page for a step, for "Open in my browser"; null for steps that have none. */
function stepUrl(run: GoogleSetupRun, step: GoogleSetupStep): string | null {
  if (step === 'account' || step === 'connect') {
    return null
  }
  return googleConsoleStepUrl(step, {
    choices: run.services ?? [],
    ...(run.projectId ? { projectId: run.projectId } : {})
  })
}

export function GoogleSetupStepCard({
  bot,
  botName,
  step,
  run,
  newest
}: {
  bot: BotRef
  botName: string
  step: GoogleSetupStep
  run: GoogleSetupRun
  /** Orca writes a waiting step card again at the bottom; only the newest copy acts. */
  newest: boolean
}): React.JSX.Element {
  const t = useTranslate()
  const [busy, setBusy] = useState(false)
  const status = run.steps[step]?.status ?? 'pending'
  const done = status === 'done' || status === 'skipped'
  // A step handed to the person stays theirs until they press Done or Take over.
  const handedBack = !done && status !== 'needs-user' && !personDoesGoogleSetupStep(run, step)
  const locked = done || handedBack || busy || !newest
  const url = run.mode === 'guide-browser' ? stepUrl(run, step) : null
  const lead = run.steps[step]?.note
  const notes = step === 'account' || step === 'connect' ? [] : googleStepNotes(step, run.kind)
  const shown = GOOGLE_SETUP_STEPS.filter((entry) => run.steps[entry]?.status !== 'skipped')
  // In Guide me here the bot reads the page the person clicks in.
  const watching = !locked && run.mode === 'guide-here' && status === 'active'
  const send = (values: string[]): void => {
    setBusy(true)
    void answerGoogleSetup(bot, 'step', values)
      .catch((error: unknown) =>
        toast.error(error instanceof Error ? error.message : String(error))
      )
      .finally(() => setBusy(false))
  }
  return (
    <div>
      <GoogleSetupCardFrame
        heading={t('bots.googleSetup.step.headingCount', 'Your turn · {{n}} of {{total}}', {
          n: shown.indexOf(step) + 1,
          total: shown.length
        })}
        trailing={
          watching ? (
            <span className="inline-flex items-center gap-1">
              <LoaderCircle className="size-3 animate-spin" aria-hidden />
              {t('bots.googleSetup.step.watching', 'Watching the page')}
            </span>
          ) : null
        }
      >
        <div className="mt-0.5 text-sm font-medium text-foreground">
          {googleSetupStepTitle(step, run.services ?? [])}
        </div>
        {lead ? <p className="mt-0.5 text-xs text-muted-foreground">{lead}</p> : null}
        {!newest && !done ? (
          <p className="mt-0.5 text-xs text-muted-foreground">
            {t('bots.googleSetup.movedDown', 'Continued further down.')}
          </p>
        ) : null}
        {notes.length > 0 ? <GoogleSetupStepNotes notes={notes} /> : null}
        <>
          {!done && !handedBack && step === 'links' ? (
            <div className="mt-2">
              <GoogleBrandingLinks />
            </div>
          ) : null}
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {url ? (
              <Button
                size="xs"
                variant="outline"
                disabled={locked}
                onClick={() => openInMyBrowser(url)}
              >
                {t('bots.googleSetup.step.openInBrowser', 'Open in browser')}
                <ExternalLink />
              </Button>
            ) : null}
            <Button
              size="xs"
              variant="outline"
              disabled={locked}
              onClick={() => send(['done', step])}
            >
              {t('bots.googleSetup.step.done', 'Done')}
            </Button>
          </div>
          {/* The policy box is the person's own tick; Take over can't do it for them. */}
          {step === 'branding' ? null : (
            <div className="mt-1.5">
              <Button
                variant="link"
                size="inlineText"
                disabled={locked}
                onClick={() => send(['take-over', step])}
              >
                {t('bots.googleSetup.takeOver', 'Take over from here')}
              </Button>
            </div>
          )}
        </>
      </GoogleSetupCardFrame>
      {done ? (
        <GoogleSetupReceipt text={t('bots.googleSetup.receipt.done', '✓ Done')} />
      ) : handedBack ? (
        <GoogleSetupReceipt
          text={t('bots.googleSetup.receipt.takeOver', '✓ {{bot}} takes over from here', {
            bot: botName
          })}
        />
      ) : null}
    </div>
  )
}
