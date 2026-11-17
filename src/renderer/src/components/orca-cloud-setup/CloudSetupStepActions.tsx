// The setup page's step actions: the current step's button, the "Waiting for your browser" state
// while a browser trip is open, and the inline note when setup couldn't start.
import React from 'react'
import { ExternalLink, LoaderCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { OpenExternalSplitButton } from '@/components/open-external/OpenExternalSplitButton'
import type { ExternalLinkSource } from '@/components/open-external/copy-external-link'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import { CloudSetupFlowBrowserButton } from './CloudSetupBrowserButton'
import type { CloudSetupFlow } from './use-cloud-setup-flow'
import { CloudCapabilityOffActions } from './CloudCapabilityOffActions'

function BrowserWaiting({ flow }: { flow: CloudSetupFlow }): React.JSX.Element {
  const t = useTranslate()
  return (
    // The status line, then its actions, flush-left. The bordered action leads so its edge
    // lines up with the copy above (a ghost button's padding would indent it).
    <div className="flex flex-col items-start gap-3" role="status">
      <span className="flex items-center gap-2 text-sm text-muted-foreground">
        <LoaderCircle className="size-4 motion-safe:animate-spin" aria-hidden />
        {t('cloudSetupPage.waitingBrowser', 'Waiting for your browser…')}
      </span>
      <span className="flex flex-wrap items-center gap-2">
        {/* "Copy link" under the chevron: a fresh one-time link for another browser or profile. */}
        <OpenExternalSplitButton
          variant="outline"
          size="sm"
          link={flow.reopenLink}
          onClick={flow.reopenBrowser}
        >
          {t('cloudSetupPage.reopenBrowser', 'Reopen browser')}
          <ExternalLink aria-hidden />
        </OpenExternalSplitButton>
        {flow.signingIn ? (
          <Button type="button" variant="ghost" size="sm" onClick={flow.cancelSignIn}>
            {t('cloudSetupPage.cancelSignIn', 'Cancel')}
          </Button>
        ) : null}
      </span>
    </div>
  )
}

export function StepActions({
  flow,
  onStart
}: {
  flow: CloudSetupFlow
  /** Present while "All set" waits for Start (the page was hidden when setup finished). */
  onStart?: (() => void) | null
}): React.JSX.Element | null {
  const t = useTranslate()
  const browser = (
    label: string,
    onClick: () => void,
    link?: ExternalLinkSource | null
  ): React.JSX.Element => <CloudSetupFlowBrowserButton {...{ flow, label, onClick, link }} />
  const inBrowserAction =
    flow.action === 'sign-in' ||
    flow.action === 'choose-plan' ||
    flow.action === 'fix-billing' ||
    flow.action === 'start-trial' ||
    flow.action === 'github-install'
  if (flow.signingIn || (flow.inBrowser && inBrowserAction && !flow.error)) {
    return <BrowserWaiting flow={flow} />
  }
  const continueLabel = t('cloudSetupPage.continueInBrowser', 'Continue in browser')
  const actions = stepActionButtons(flow, browser, continueLabel, t, onStart)
  return flow.startFailed && actions ? (
    <div className="flex flex-col items-start gap-3">
      <p role="status" className="text-sm text-destructive-text">
        {t('cloudSetupPage.startFailed', 'Couldn’t start setup. Try again.')}
      </p>
      {actions}
    </div>
  ) : (
    actions
  )
}

function stepActionButtons(
  flow: CloudSetupFlow,
  browser: (
    label: string,
    onClick: () => void,
    link?: ExternalLinkSource | null
  ) => React.JSX.Element,
  continueLabel: string,
  t: Translate,
  onStart: (() => void) | null | undefined
): React.JSX.Element | null {
  switch (flow.action) {
    case 'sign-in':
      return flow.signInDidNotFinish ? (
        <div className="flex flex-col items-start gap-3">
          <p role="status" className="text-sm text-muted-foreground">
            {t('cloudSetupPage.signIn.didNotFinish', 'Sign-in didn’t finish. Try again.')}
          </p>
          {browser(continueLabel, flow.continueInBrowser, flow.continueLink)}
        </div>
      ) : (
        browser(continueLabel, flow.continueInBrowser, flow.continueLink)
      )
    case 'choose-plan':
      // Copy link is for sign-in only: a plan is chosen in the browser that opens.
      return browser(continueLabel, flow.continueInBrowser)
    case 'fix-billing':
      // Payment, hours and the spend cap are all changed on the console's billing page.
      return browser(continueLabel, flow.fixBilling)
    case 'github-install':
      return browser(continueLabel, flow.installGitHub)
    case 'start-trial':
      return browser(t('cloudSetupPage.trial.startInBrowser', 'Start in browser'), flow.startTrial)
    case 'switch-team':
      return <div>{flow.teamAction}</div>
    case 'needs-repository':
      return flow.current?.action ? (
        <Button type="button" variant="outline" onClick={flow.current.action.onClick}>
          {flow.current.action.label}
          <ExternalLink aria-hidden />
        </Button>
      ) : null
    case 'ask-owner':
      return (
        <Button type="button" variant="outline" onClick={flow.checkAgain}>
          {t('cloudSetupPage.checkAgain', 'Check again')}
        </Button>
      )
    case 'capability-off':
      return <CloudCapabilityOffActions onTryAgain={flow.checkAgain} contactUrl={flow.contactUrl} />
    case 'github-waiting':
      return (
        <span className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
          <LoaderCircle className="size-4 motion-safe:animate-spin" aria-hidden />
          {t('cloudSetupPage.github.waiting', 'This page starts the workspace once they approve.')}
        </span>
      )
    case 'checking':
      return <Skeleton className="h-9 w-40" />
    case 'done':
      if (onStart) {
        return (
          // The one action left on a page the user came back to: focused, so Enter starts.
          <Button type="button" autoFocus onClick={onStart}>
            {t('cloudSetupPage.start', 'Start')}
          </Button>
        )
      }
      return (
        <span className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
          <LoaderCircle className="size-4 motion-safe:animate-spin" aria-hidden />
          {t('cloudSetupPage.starting', 'Starting…')}
        </span>
      )
  }
}
