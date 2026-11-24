// What a Google setup card shows and which of its buttons act, from the run and where the host says
// it's stuck. The computer's cards and the phone's draw from these, so both agree.
import {
  GOOGLE_CHOICE_SERVICES,
  googleChoices,
  GOOGLE_SERVICE_CHOICES,
  type GoogleServiceChoice
} from './google-scopes'
import type { GoogleSetupAction, GoogleSetupBlocker } from './google-setup-blocker'
import {
  currentGoogleSetupStep,
  GOOGLE_SETUP_STEPS,
  googleSetupAwaitsKey,
  personDoesGoogleSetupStep,
  type GoogleSetupCard,
  type GoogleSetupRun,
  type GoogleSetupStep
} from './google-setup-run'

/** A choice made before the bot started in Google Cloud can still change; after, it says so in chat. */
export function googleSetupChoiceChangeable(run: GoogleSetupRun): boolean {
  return run.state === 'running' && (run.steps.project?.status ?? 'pending') === 'pending'
}

/** The services the owner picked on the services card, or null before they answered. */
export function googleSetupAnsweredServices(run: GoogleSetupRun): GoogleServiceChoice[] | null {
  const values = run.answers.services?.values
  if (!values) {
    return null
  }
  return googleChoices(GOOGLE_SERVICE_CHOICES.filter((choice) => values.includes(choice)))
}

/** The choices an account can use now: it has each one's services and every one of them is ready. A
 *  service this build doesn't know counts for none. */
export function googleReadyChoices(account: {
  services: readonly { service: string; state: string }[]
}): GoogleServiceChoice[] {
  return GOOGLE_SERVICE_CHOICES.filter((choice) => {
    const entries = account.services.filter((entry) =>
      GOOGLE_CHOICE_SERVICES[choice].some((service) => service === entry.service)
    )
    return entries.length > 0 && entries.every((entry) => entry.state === 'ready')
  })
}

/** Blockers the sign-in card shows: the key, and the account once signed in. */
export function googleSetupBlockerIsConnect(blocker: GoogleSetupBlocker): boolean {
  return blocker.kind !== 'stopped' && blocker.kind !== 'paused' && blocker.kind !== 'needs-user'
}

/** The steps the list shows: every one not skipped. */
export function googleSetupShownSteps(run: GoogleSetupRun): GoogleSetupStep[] {
  return GOOGLE_SETUP_STEPS.filter((step) => run.steps[step]?.status !== 'skipped')
}

export type GoogleSetupProgressView = {
  steps: GoogleSetupStep[]
  state: 'working' | 'waiting' | 'done' | null
  /** One signed-in account is used without asking; this switches it before the bot starts in Google Cloud. */
  switchAccount: boolean
  /** The step the bot is doing now, which the owner may take ("Let me do this one"). */
  letMe: GoogleSetupStep | null
  /** Where it's stuck, when the progress card is the one to say so. */
  panel: GoogleSetupBlocker | null
  /** A key Orca may have missed, which the owner imports by hand. */
  keyImport: boolean
}

/** The live step list. Only the newest copy in the chat acts: it waits for the key and shows the buttons. */
export function googleSetupProgressView(
  run: GoogleSetupRun,
  blocker: GoogleSetupBlocker | null,
  newest: boolean
): GoogleSetupProgressView {
  const clientStatus = run.steps.client?.status
  // Before client is done, a missed key's recovery (Make a new key, Import a key file) shows here;
  // the sign-in card takes over the key's blockers after.
  const panel =
    newest &&
    blocker &&
    (blocker.kind === 'stopped' ||
      blocker.kind === 'paused' ||
      (googleSetupAwaitsKey(run) && googleSetupBlockerIsConnect(blocker)))
      ? blocker
      : null
  const current = currentGoogleSetupStep(run)
  const steps = googleSetupShownSteps(run)
  // The sign-in at the end is always the owner's, on its own card.
  const waiting =
    current === 'connect' || steps.some((step) => run.steps[step]?.status === 'needs-user')
  const botDoing =
    newest &&
    run.state === 'running' &&
    current !== null &&
    current !== 'connect' &&
    run.steps[current]?.status !== 'needs-user' &&
    !personDoesGoogleSetupStep(run, current)
  return {
    steps,
    state:
      run.state === 'done'
        ? 'done'
        : waiting
          ? 'waiting'
          : run.state === 'running'
            ? 'working'
            : null,
    switchAccount:
      newest &&
      run.steps.account?.status === 'done' &&
      (run.accounts?.length ?? 0) <= 1 &&
      googleSetupChoiceChangeable(run),
    letMe: botDoing ? current : null,
    panel,
    keyImport:
      newest &&
      !panel &&
      googleSetupAwaitsKey(run) &&
      (clientStatus === 'active' || clientStatus === 'needs-user')
  }
}

export type GoogleSetupStepCardView = {
  /** Its place among the shown steps, from 1. */
  n: number
  total: number
  done: boolean
  /** The bot took it back ("Take over from here"); a step handed to the person stays theirs until then. */
  handedBack: boolean
  /** Done and Take over act: the step is the person's, open, and this is the newest copy. */
  acts: boolean
  /** The policy box is the person's own tick; Take over can't do it for them. */
  takeOver: boolean
  /** In Guide me here the bot reads the page the person clicks in. */
  watching: boolean
}

export function googleSetupStepCardView(
  run: GoogleSetupRun,
  step: GoogleSetupStep,
  newest: boolean
): GoogleSetupStepCardView {
  const status = run.steps[step]?.status ?? 'pending'
  const done = status === 'done' || status === 'skipped'
  const handedBack = !done && status !== 'needs-user' && !personDoesGoogleSetupStep(run, step)
  const acts = !done && !handedBack && newest
  const shown = googleSetupShownSteps(run)
  return {
    n: shown.indexOf(step) + 1,
    total: shown.length,
    done,
    handedBack,
    acts,
    takeOver: step !== 'branding',
    watching: acts && run.mode === 'guide-here' && status === 'active'
  }
}

/** The card answer a blocker's button records, or null for one that acts on the computer itself (a
 *  sign-in, a key file, a page or the clipboard) or has nothing left to record. */
export function googleSetupActionAnswer(
  action: GoogleSetupAction,
  run: GoogleSetupRun
): { card: GoogleSetupCard; values: string[] } | null {
  switch (action.id) {
    case 'make-new-key':
      return { card: 'step', values: ['redo', 'client'] }
    case 'continue-without': {
      const left = (run.services ?? []).filter((choice) => !action.services.includes(choice))
      // The host offers it only with a service left; an answer needs at least one.
      return left.length > 0 ? { card: 'services', values: left } : null
    }
    case 'keep-account':
      return { card: 'account', values: [action.email] }
    case 'continue':
      return { card: 'step', values: ['resume'] }
    case 'start-over':
      return { card: 'step', values: ['start-over'] }
    case 'let-me':
      return { card: 'step', values: ['let-me', action.step] }
    case 'done':
      return { card: 'step', values: ['done', action.step] }
    case 'import-key':
    case 'allow':
    case 'sign-in-again':
    case 'turn-on':
    case 'copy-for-admin':
    case 'check-again':
      return null
  }
}
