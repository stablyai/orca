// The live step list, and the card for a step the person does. Neither posts a chat message: Done,
// "Take over from here" and "Let me do this one" are card answers the bot reads.
import React, { useCallback, useState } from 'react'
import { Check, ExternalLink, LoaderCircle } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import { botTarget, type BotRef, useStableBotRef } from '@/lib/bot-hosts'
import {
  googleSetupAwaitsKey,
  type GoogleSetupRun,
  type GoogleSetupStep
} from '../../../../../../shared/google/google-setup-run'
import {
  googleSetupProgressView,
  googleSetupStepCardView
} from '../../../../../../shared/google/google-setup-card-view'
import { GoogleBrandingLinks } from '../GoogleBrandingLinks'
import { googleConsoleStepUrl } from '../../../../../../shared/google/google-console-setup'
import type { GoogleSetupKeyCandidate } from '../../../../../../shared/rpc-contract/google-setup-params'
import { withTimeout } from '../../../../../../shared/concurrency/promise-timeout-fallback'
import type { GoogleSetupFoundKey } from '../../../../../../shared/google/google-setup-ipc-types'
import {
  type GoogleHostView,
  importGoogleApp,
  openInMyBrowser,
  refreshGoogle
} from '../google-connect-client'
import { googleKeyRefusalHeadline, googleStepNotes } from '../google-copy'
import { useGoogleClientFile } from '../use-google-client-file'
import { GoogleSetupBlockerPanel } from './GoogleSetupBlockerPanel'
import { useCaptureClientKey, type KeySource } from '../use-capture-google-key'
import {
  GoogleSetupCardFrame,
  GoogleSetupReceipt,
  GoogleSetupStepNotes
} from './GoogleSetupCardParts'
import { googleSetupStepTitle } from './google-setup-card-copy'
import {
  answerGoogleSetup,
  importGoogleSetupKeyOnHost,
  useGoogleSetupBlocker
} from './google-setup-run-store'

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

const DONE_KEY_READ_TIMEOUT_MS = 3000

/** Whether a key found in Downloads replaces the host's saved one: only a newer file does (Make a
 *  new key), so a key saved elsewhere, or one Google no longer knows, isn't re-imported. No host
 *  view counts as no saved key. */
function importsFoundKey(found: GoogleSetupFoundKey, host: GoogleHostView | null): boolean {
  const google = host?.status === 'ready' ? host.google : null
  return !google?.client || found.modifiedAt > google.client.savedAt
}

/** A step card answer. Done on the key step in the person's own browser saves a key already in
 *  Downloads first: the watch only sees files that land while its card is on screen. */
async function answerStepCard(bot: BotRef, run: GoogleSetupRun, values: string[]): Promise<void> {
  if (values[0] === 'done' && values[1] === 'client' && keySource(run, true)) {
    // Each read has its own limit, so a slow host doesn't drop a found key; a stalled Downloads mount
    // answers Done as before.
    const [found, host] = await Promise.all([
      withTimeout(
        window.api.googleSetup.findDownloadedKey({
          since: run.startedAt,
          ...(run.projectId ? { projectId: run.projectId } : {})
        }),
        DONE_KEY_READ_TIMEOUT_MS,
        null
      ),
      withTimeout(refreshGoogle(botTarget(bot)), DONE_KEY_READ_TIMEOUT_MS, null)
    ])
    if (found && importsFoundKey(found, host)) {
      return saveKey(bot, found.text)
    }
  }
  await answerGoogleSetup(bot, 'step', values)
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
  // Files on the bot's host that it can't tell apart: the owner picks one.
  const [candidates, setCandidates] = useState<GoogleSetupKeyCandidate[]>([])
  const fromHost = async (picked?: GoogleSetupKeyCandidate): Promise<boolean> => {
    const reply = await importGoogleSetupKeyOnHost(bot, picked)
    setCandidates(reply && !reply.found ? reply.candidates : [])
    if (reply?.found) {
      await refreshGoogle(botTarget(bot))
    }
    return reply !== null && (reply.found || reply.candidates.length > 0)
  }
  // A bot on another host: its browser's download is there, so that host looks first.
  const file = useGoogleClientFile((text) => saveKey(bot, text), { tryHost: () => fromHost() })
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
      {candidates.length > 0 ? (
        <div className="mt-1 flex flex-col items-start">
          {t('bots.googleSetup.pickHostKey', 'Pick the key file to import:')}
          {candidates.map((candidate) => (
            <Button
              key={candidate.id}
              variant="link"
              size="inlineText"
              disabled={file.busy}
              onClick={() =>
                void fromHost(candidate).catch((error: unknown) =>
                  toast.error(error instanceof Error ? error.message : String(error))
                )
              }
            >
              {candidate.name}
            </Button>
          ))}
          <Button
            variant="link"
            size="inlineText"
            disabled={file.busy}
            onClick={() => void file.pickHere()}
          >
            {t('bots.googleSetup.pickKeyHere', 'Choose a file on this computer')}
          </Button>
        </div>
      ) : null}
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
  const view = googleSetupProgressView(run, blocker, capture.owns)
  const { panel, letMe } = view
  const services = run.services ?? []
  const state =
    view.state === 'done'
      ? t('bots.googleSetup.progress.done', 'Done')
      : view.state === 'waiting'
        ? t('bots.googleSetup.progress.waiting', 'Waiting for you')
        : view.state === 'working'
          ? t('bots.googleSetup.progress.working', 'Working')
          : null
  return (
    <GoogleSetupCardFrame
      heading={t('bots.googleSetup.progress.heading', 'Setting up Google')}
      trailing={
        state ? (
          <span className="inline-flex items-center gap-1">
            {view.state === 'working' ? (
              <LoaderCircle className="size-3 animate-spin" aria-hidden />
            ) : null}
            {state}
          </span>
        ) : null
      }
    >
      <ol className="mt-1 space-y-1.5">
        {view.steps.map((step, index) => {
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
                {step === 'account' && view.switchAccount ? (
                  <Button
                    variant="link"
                    size="inlineText"
                    onClick={() => answerAccount(bot, ['other'])}
                  >
                    {t('bots.googleSetup.otherAccount', 'Switch account')}
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
      {view.keyImport ? <KeyImport bot={bot} /> : null}
      {panel ? <GoogleSetupBlockerPanel bot={bot} run={run} blocker={panel} /> : null}
      {letMe ? (
        <div className="mt-2">
          <Button
            variant="link"
            size="inlineText"
            onClick={() => answerStep(bot, ['let-me', letMe])}
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
  const { n, total, done, handedBack, acts, takeOver, watching } = googleSetupStepCardView(
    run,
    step,
    newest
  )
  const locked = !acts || busy
  const url = run.mode === 'guide-browser' ? stepUrl(run, step) : null
  const lead = run.steps[step]?.note
  const notes = step === 'account' || step === 'connect' ? [] : googleStepNotes(step, run.kind)
  const send = (values: string[]): void => {
    setBusy(true)
    void answerStepCard(bot, run, values)
      .catch((error: unknown) =>
        toast.error(error instanceof Error ? error.message : String(error))
      )
      .finally(() => setBusy(false))
  }
  return (
    <div>
      <GoogleSetupCardFrame
        heading={t('bots.googleSetup.step.headingCount', 'Your turn · {{n}} of {{total}}', {
          n,
          total
        })}
        trailing={
          watching && !busy ? (
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
          {takeOver ? (
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
          ) : null}
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
