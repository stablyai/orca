// The card's words for where a setup is stuck and its buttons. They match the host's English
// (google-setup-blocker.ts), which `orca bot google-setup show` prints, so the bot names the same.
import { translate } from '@/i18n/i18n'
import {
  GOOGLE_SETUP_ALLOW_NAMES_UP_TO,
  type GoogleSetupAction,
  type GoogleSetupBlocker
} from '../../../../../../shared/google/google-setup-blocker'
import { googleSetupServicesList, googleSetupStepTitle } from './google-setup-card-copy'

export function googleSetupActionText(action: GoogleSetupAction): string {
  switch (action.id) {
    case 'make-new-key':
      return translate('bots.googleSetup.action.makeNewKey', 'Make a new key')
    case 'import-key':
      return translate('bots.googleSetup.action.importKey', 'Import a key file')
    case 'allow':
      return action.services.length <= GOOGLE_SETUP_ALLOW_NAMES_UP_TO
        ? translate('bots.googleSetup.action.allow', 'Allow {{services}}', {
            services: googleSetupServicesList(action.services)
          })
        : translate('bots.googleSetup.action.signInAgain', 'Sign in again')
    case 'continue-without':
      return translate('bots.googleSetup.action.continueWithout', 'Continue without them')
    case 'keep-account':
      return translate('bots.googleSetup.action.keep', 'Keep {{email}}', { email: action.email })
    case 'sign-in-again':
      return action.email
        ? translate('bots.googleSetup.action.signInAs', 'Sign in as {{email}}', {
            email: action.email
          })
        : translate('bots.googleSetup.action.signInAgain', 'Sign in again')
    case 'turn-on':
      return translate('bots.googleSetup.action.turnOn', 'Turn on')
    case 'copy-for-admin':
      return translate('bots.googleSetup.action.copyForAdmin', 'Copy for your admin')
    case 'check-again':
      return translate('bots.googleSetup.action.checkAgain', 'Check again')
    case 'continue':
      return translate('bots.googleSetup.action.continue', 'Continue')
    case 'start-over':
      return translate('bots.googleSetup.action.startOver', 'Start over')
    case 'let-me':
      return translate('bots.googleSetup.letMe', 'Let me do this one')
    case 'done':
      return translate('bots.googleSetup.step.done', 'Done')
  }
}

export function googleSetupBlockerText(blocker: GoogleSetupBlocker): string {
  switch (blocker.kind) {
    case 'stopped':
      return blocker.reason
        ? translate('bots.googleSetup.blocker.stoppedWhy', 'Setup stopped: {{reason}}', {
            reason: blocker.reason
          })
        : translate('bots.googleSetup.blocker.stopped', 'Setup stopped.')
    case 'paused':
      return translate(
        'bots.googleSetup.blocker.paused',
        'The setup paused at {{step}}. Everything so far is saved.',
        { step: googleSetupStepTitle(blocker.step, []) }
      )
    case 'needs-user':
      return (
        blocker.note ??
        translate('bots.googleSetup.blocker.yourTurn', 'Your turn: {{step}}.', {
          step: googleSetupStepTitle(blocker.step, [])
        })
      )
    case 'no-key':
      return translate('bots.googleSetup.blocker.noKey', 'Orca needs the app’s key first.')
    case 'key-gone':
      return translate(
        'bots.googleSetup.blocker.keyGone',
        'This app’s key no longer works: it was removed in Google Cloud.'
      )
    case 'key-other-project':
      return translate(
        'bots.googleSetup.blocker.keyOtherProject',
        'The saved key is for project {{keyProject}}, not {{project}}.',
        { keyProject: blocker.keyProjectId, project: blocker.projectId }
      )
    case 'other-account':
      return translate(
        'bots.googleSetup.blocker.otherAccount',
        'You signed in as {{signedIn}}; this setup was for {{wanted}}.',
        { signedIn: blocker.signedIn, wanted: blocker.wanted }
      )
    case 'signed-out':
      return translate('bots.googleSetup.blocker.signedOut', 'The sign-in for {{email}} ended.', {
        email: blocker.email
      })
    case 'needs-permission':
      return translate(
        'bots.googleSetup.blocker.needsPermission',
        'Almost there: allow {{services}}. Google shows a box for each one; tick them all.',
        { services: googleSetupServicesList(blocker.services) }
      )
    case 'api-off':
      return translate(
        'bots.googleSetup.blocker.apiOff',
        '{{services}} is turned off in Google Cloud.',
        { services: googleSetupServicesList(blocker.services) }
      )
    case 'admin-blocked':
      return translate(
        'bots.googleSetup.blocker.adminBlocked',
        'Your company’s Google admin blocked {{services}}.',
        { services: googleSetupServicesList(blocker.services) }
      )
    case 'check-failed':
      return translate(
        'bots.googleSetup.blocker.checkFailed',
        'Orca couldn’t check {{services}}.',
        { services: googleSetupServicesList(blocker.services) }
      )
  }
}
