// Approve in Slack: Slack's approval page in this computer's browser, then the wait for it.
import { useCallback, useRef, type Dispatch, type RefObject, type SetStateAction } from 'react'
import type { SlackInstallLink } from './slack-install-link'
import { openSlackApprovalHere } from './slack-page-here'
import type { BotSlackSetupStep, OpenedSlackPage, SetupMount } from './use-bot-slack-setup'

/**
 * One launch per step, and it moves on only from the step it began on, in the dialog it began in:
 * a later Install again, Copy link or close wins over a launch that answers late.
 */
export function useSlackApprove(
  step: BotSlackSetupStep,
  setStep: Dispatch<SetStateAction<BotSlackSetupStep>>,
  mounted: RefObject<SetupMount | null>,
  remember: (teamId: string, link: SlackInstallLink) => OpenedSlackPage
): () => void {
  // The launch in flight: its page and dialog. A step change, such as Copy link, doesn't start
  // another launch of the same page while that one is pending.
  const launching = useRef<{ url: string; mount: SetupMount | null } | null>(null)
  return useCallback(() => {
    const at = step
    if ((at.kind !== 'ready' && at.kind !== 'waiting') || !at.link) {
      return
    }
    const [mount, link, teamId] = [mounted.current, at.link, at.teamId]
    const pending = launching.current
    if (pending && pending.url === link.authorizeUrl && pending.mount === mount) {
      return
    }
    const launch = { url: link.authorizeUrl, mount }
    launching.current = launch
    // Waits only once this computer's browser took Slack's page; a failed launch stays here.
    void openSlackApprovalHere(link.authorizeUrl).then((opened) => {
      if (launching.current === launch) {
        launching.current = null
      }
      if (!opened || mounted.current !== mount) {
        return
      }
      // Checked against the step as it is when applied, so a Copy link in the same batch wins.
      // Recording the page is idempotent, so a repeated updater call changes nothing more.
      setStep((current) =>
        current === at
          ? { kind: 'waiting', teamId, ...remember(teamId, link), copied: false }
          : current
      )
    })
  }, [step, setStep, mounted, remember])
}
