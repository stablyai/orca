// Settings › Google wording. Each line says what to do or what you get.
import { translate } from '@/i18n/i18n'
import type {
  GoogleAccountView,
  GoogleServiceReadiness
} from '../../../../../shared/google/google-connect-types'
import type { GoogleConsoleStep } from '../../../../../shared/google/google-console-setup'
import {
  GOOGLE_CHOICE_SERVICES,
  GOOGLE_SERVICE_INFO,
  type GoogleService,
  type GoogleServiceChoice
} from '../../../../../shared/google/google-scopes'

export function googleChoiceLabel(choice: GoogleServiceChoice): string {
  switch (choice) {
    case 'gmail':
      return translate('bots.google.choice.gmail', 'Gmail')
    case 'calendar':
      return translate('bots.google.choice.calendar', 'Calendar')
    case 'files':
      return translate('bots.google.choice.files', 'Drive, Docs and Sheets')
  }
}

export function googleChoiceDescription(choice: GoogleServiceChoice): string {
  switch (choice) {
    case 'gmail':
      return translate(
        'bots.google.choice.gmailDescription',
        'Search and read mail, write drafts, send when you say so'
      )
    case 'calendar':
      return translate('bots.google.choice.calendarDescription', 'See, create and move events')
    case 'files':
      return translate('bots.google.choice.filesDescription', 'Find, read and edit files')
  }
}

export function googleServiceLabel(service: GoogleService): string {
  return service === 'contacts'
    ? translate('bots.google.service.contacts', 'Find people by name')
    : GOOGLE_SERVICE_INFO[service].label
}

/** A readiness row's words, and the one action that fixes it. */
export function googleReadinessFace(readiness: GoogleServiceReadiness): {
  label: string
  fix: 'turn-on' | 'allow-again' | 'copy-for-admin' | 'check-again' | null
} {
  switch (readiness.state) {
    case 'ready':
      return { label: translate('bots.google.state.ready', 'Ready'), fix: null }
    case 'api-disabled':
      return {
        label: translate('bots.google.state.apiOff', 'Turned off in Google Cloud'),
        fix: 'turn-on'
      }
    case 'needs-permission':
      return {
        label: translate('bots.google.state.notAllowed', 'You didn’t allow it'),
        fix: 'allow-again'
      }
    case 'blocked-by-admin':
      return {
        label: translate(
          'bots.google.state.adminBlocked',
          'Your company’s Google admin blocked it'
        ),
        fix: 'copy-for-admin'
      }
    case 'error':
      return {
        label: readiness.detail ?? translate('bots.google.state.error', 'Couldn’t check'),
        fix: 'check-again'
      }
  }
}

export function googleFixLabel(fix: NonNullable<ReturnType<typeof googleReadinessFace>['fix']>) {
  switch (fix) {
    case 'turn-on':
      return translate('bots.google.fix.turnOn', 'Turn on')
    case 'allow-again':
      return translate('bots.google.fix.allowAgain', 'Allow again')
    case 'copy-for-admin':
      return translate('bots.google.fix.copyForAdmin', 'Copy for your admin')
    case 'check-again':
      return translate('bots.google.fix.checkAgain', 'Check again')
  }
}

/** One row per thing the person picked (Drive, Docs and Sheets together), each showing its worst state. */
export type GoogleReadinessRow = { key: string; label: string; readiness: GoogleServiceReadiness }

export function googleReadinessRows(account: GoogleAccountView): GoogleReadinessRow[] {
  const rows = new Map<string, GoogleReadinessRow>()
  for (const readiness of account.services) {
    const files = GOOGLE_CHOICE_SERVICES.files.includes(readiness.service)
    const key = files ? 'files' : readiness.service
    const current = rows.get(key)
    if (!current || (current.readiness.state === 'ready' && readiness.state !== 'ready')) {
      rows.set(key, {
        key,
        label: files ? googleChoiceLabel('files') : googleServiceLabel(readiness.service),
        readiness
      })
    }
  }
  return [...rows.values()]
}

/** The rows that still need something. */
export function googleProblems(account: GoogleAccountView): GoogleReadinessRow[] {
  return googleReadinessRows(account).filter((row) => row.readiness.state !== 'ready')
}

/** The account's headline: connected, ended, or how many things to fix. */
export function googleAccountHeadline(account: GoogleAccountView): string {
  if (account.status === 'reconnect') {
    return translate('bots.google.headline.ended', 'Google access ended. Reconnect.')
  }
  const problems = googleProblems(account).length
  return problems === 0
    ? translate('bots.google.headline.connected', 'Google is connected')
    : translate('bots.google.headline.toFix', 'Almost there: {{count}} things to fix', {
        count: problems,
        defaultValue_one: 'Almost there: 1 thing to fix'
      })
}

/** What a company admin pastes to their Workspace admin to trust the app. */
export function googleAdminRequest(clientId: string): string {
  return translate(
    'bots.google.adminRequest',
    'Please mark this Google app as Trusted in the Admin console (Security › API controls › Manage third-party app access): {{clientId}}',
    { clientId }
  )
}

export function googleStepTitle(step: GoogleConsoleStep, services: string): string {
  switch (step) {
    case 'project':
      return translate('bots.google.step.project', 'Create a project')
    case 'apis':
      return translate('bots.google.step.apis', 'Turn on {{services}}', { services })
    case 'branding':
      return translate('bots.google.step.branding', 'Set up Google’s sign-in screen')
    case 'links':
      return translate('bots.google.step.links', 'Add your app’s links')
    case 'publish':
      return translate('bots.google.step.publish', 'Publish the app')
    case 'client':
      return translate('bots.google.step.client', 'Create the app’s key')
  }
}

/**
 * What the person does on a step, one numbered line each. Key words are wrapped in <b></b>; render
 * them with Trans.
 */
export function googleStepNotes(
  step: GoogleConsoleStep,
  kind: 'work' | 'personal' | undefined
): string[] {
  switch (step) {
    case 'project':
      return [
        translate(
          'bots.google.notes.project.account',
          'Check the account at the top right is the one you want.'
        ),
        translate(
          'bots.google.notes.project.create',
          'Click <b>Create</b>. The name doesn’t matter.'
        )
      ]
    case 'apis':
      return [
        translate(
          'bots.google.notes.apis.project',
          'Check the project at the top is the one you just made.'
        ),
        translate('bots.google.notes.apis.enable', 'Click <b>Next</b>, then <b>Enable</b>.')
      ]
    case 'branding':
      return [
        translate('bots.google.notes.branding.start', 'Click <b>Get started</b>.'),
        translate(
          'bots.google.notes.branding.name',
          'App name <b>Orca</b>, and your email as the support email.'
        ),
        kind === 'personal'
          ? translate('bots.google.notes.branding.external', 'Audience: <b>External</b>.')
          : kind === 'work'
            ? translate('bots.google.notes.branding.internal', 'Audience: <b>Internal</b>.')
            : translate(
                'bots.google.notes.branding.either',
                'Audience: <b>External</b> for a Gmail account, <b>Internal</b> for a work account.'
              ),
        translate('bots.google.notes.branding.contact', 'Your email as the contact email.'),
        translate(
          'bots.google.notes.branding.agree',
          'Tick <b>I agree to the Google API Services: User Data Policy</b>, then <b>Create</b>.'
        )
      ]
    case 'links':
      return [
        translate(
          'bots.google.notes.links.domain',
          'Under <b>App domain</b>, paste the home page and privacy policy links.'
        ),
        translate(
          'bots.google.notes.links.authorized',
          'Under <b>Authorized domains</b>, add the domain.'
        ),
        translate('bots.google.notes.links.save', 'Click <b>Save</b>.')
      ]
    case 'publish':
      return [
        translate(
          'bots.google.notes.publish.publish',
          'Click <b>Publish app</b>, then <b>Confirm</b>.'
        ),
        translate(
          'bots.google.notes.publish.why',
          'A published app keeps you signed in past 7 days.'
        )
      ]
    case 'client':
      return [
        translate(
          'bots.google.notes.client.type',
          'Application type: <b>Desktop app</b>, then <b>Create</b>.'
        ),
        translate(
          'bots.google.notes.client.agent',
          'If you see <b>Use this client for an AI-powered agent</b>, tick it.'
        ),
        translate(
          'bots.google.notes.client.download',
          'Click <b>Download JSON</b>. Orca saves the key.'
        )
      ]
  }
}

/** A host's refusal of a key file without its Google Cloud how-to, for the checklist that shows the steps. */
export function googleKeyRefusalHeadline(message: string): string {
  const howTo = message.indexOf(' In Google Cloud Console,')
  return howTo > 0 ? message.slice(0, howTo) : message
}

/** Why this window's Google sign-in stopped, as its error says it. */
export function googleSignInRunError(
  why: 'cancelled' | 'failed' | 'noAccount' | 'alreadyRunning' | 'notWaiting'
): string {
  switch (why) {
    case 'cancelled':
      return translate('bots.google.signInRun.cancelled', 'The Google sign-in was cancelled.')
    case 'failed':
      return translate('bots.google.signInRun.failed', 'The Google sign-in failed. Try again.')
    case 'noAccount':
      return translate(
        'bots.google.signInRun.noAccount',
        'Google signed in, but the host sent no account.'
      )
    case 'alreadyRunning':
      return translate(
        'bots.google.signInRun.alreadyRunning',
        'A Google sign-in is already running. Finish or cancel it first.'
      )
    case 'notWaiting':
      return translate(
        'bots.google.signInRun.notWaiting',
        'No Google sign-in is waiting. Start again.'
      )
  }
}
