// Each setup dialog a bot asks for Orca sign-in in, signed out and once Sign in carried it on.
import { defineFixture } from '../../component-fixtures/component-fixture'
import { ConfirmationDialogProvider } from '../dismiss/confirmation/confirmation-dialog'
import {
  openGitHubInstall,
  resetGitHubInstallForTests,
  useGitHubInstallRecord
} from '@/lib/bot-github-install-record'
import { BotGitHubSetupDialog } from './github/BotGitHubSetupDialog'
import { BotLinearSetupDialog } from './linear/BotLinearSetupDialog'
import { BotShareFlow } from './sharing/BotShareFlow'
import { BotSlackSetupDialog } from './slack/BotSlackSetupDialog'
import {
  click,
  cos,
  settle,
  signIn,
  signedOutStore,
  stubCloud
} from './orca-cloud-sign-in-host-fixture'

const slackDialog = (): React.JSX.Element => (
  <ConfirmationDialogProvider>
    <BotSlackSetupDialog bot={cos} open onOpenChange={() => {}} />
  </ConfirmationDialogProvider>
)
function GitHubSetup(): React.JSX.Element | null {
  const record = useGitHubInstallRecord()
  return record ? (
    <ConfirmationDialogProvider>
      <BotGitHubSetupDialog bot={cos} record={record} />
    </ConfirmationDialogProvider>
  ) : null
}
const openGitHub = (): void => {
  stubCloud()
  resetGitHubInstallForTests()
  openGitHubInstall(cos)
}
const linearDialog = (): React.JSX.Element => (
  <ConfirmationDialogProvider>
    <BotLinearSetupDialog bot={cos} open onOpenChange={() => {}} />
  </ConfirmationDialogProvider>
)
const shareDialog = (): React.JSX.Element => <BotShareFlow bot={cos} onClose={() => {}} />

/** Add a connector › Slack, signed out: the reason, Cancel, Sign in. */
export const slackSignedOut = defineFixture({
  width: 1000,
  store: signedOutStore(),
  setup: () => stubCloud(),
  render: slackDialog
})
/** Sign in pressed: the browser is open and the dialog waits in place. */
export const slackWaiting = defineFixture({
  width: 1000,
  store: signedOutStore(true),
  setup: () => stubCloud(),
  render: slackDialog,
  interact: () => click('Sign in').then(() => settle(300))
})
/** Signed in: the same dialog carries on to Create Slack app. */
export const slackResumed = defineFixture({
  width: 1000,
  store: signedOutStore(),
  setup: () => stubCloud(),
  render: slackDialog,
  interact: signIn
})

export const gitHubSignedOut = defineFixture({
  width: 1000,
  store: signedOutStore(),
  setup: openGitHub,
  render: () => <GitHubSetup />
})
export const gitHubResumed = defineFixture({
  width: 1000,
  store: signedOutStore(),
  setup: openGitHub,
  render: () => <GitHubSetup />,
  interact: signIn
})

export const linearSignedOut = defineFixture({
  width: 1000,
  store: signedOutStore(),
  setup: () => stubCloud(),
  render: linearDialog
})
export const linearResumed = defineFixture({
  width: 1000,
  store: signedOutStore(),
  setup: () => stubCloud(),
  render: linearDialog,
  interact: signIn
})

/** Share bot…, signed out: review the parts before signing in. */
export const shareSignedOut = defineFixture({
  width: 1000,
  store: signedOutStore(),
  setup: () => stubCloud(),
  render: shareDialog
})
export const shareResumed = defineFixture({
  width: 1000,
  store: signedOutStore(),
  setup: () => stubCloud(),
  render: shareDialog,
  interact: () => click('Sign in to publish').then(() => settle(1500))
})
