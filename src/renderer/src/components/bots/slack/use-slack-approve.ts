// Approve in Slack: Slack's approval page in this computer's browser, then the wait for it.
import {
  useCallback,
  useEffect,
  useRef,
  type Dispatch,
  type RefObject,
  type SetStateAction
} from 'react'
import type { SlackInstallLink } from './slack-install-link'
import { openSlackApprovalHere } from './slack-page-here'
import type { BotSlackSetupStep, OpenedSlackPage, SetupMount } from './use-bot-slack-setup'

type ApproveStep = Extract<BotSlackSetupStep, { kind: 'ready' | 'waiting' }>
/** A page still opening, and the step its success moves on from: the newest Approve for it. */
type Launch = { at: ApproveStep; link: SlackInstallLink }

/**
 * At most one launch per page in this dialog. Approve again for a page still opening joins that
 * launch instead of opening it twice. A launch moves on only from the step it was last asked from,
 * in the dialog it began in: a later Install again, Copy link or close wins over a late answer.
 */
export function useSlackApprove(
  step: BotSlackSetupStep,
  setStep: Dispatch<SetStateAction<BotSlackSetupStep>>,
  mounted: RefObject<SetupMount | null>,
  remember: (teamId: string, link: SlackInstallLink) => OpenedSlackPage
): () => void {
  const pending = useRef(new Map<string, Launch>())
  useEffect(() => {
    const launches = pending.current
    return () => launches.clear()
  }, [])
  return useCallback(() => {
    const at = step
    if ((at.kind !== 'ready' && at.kind !== 'waiting') || !at.link) {
      return
    }
    const url = at.link.authorizeUrl
    const joined = pending.current.get(url)
    if (joined) {
      Object.assign(joined, { at, link: at.link })
      return
    }
    const launch: Launch = { at, link: at.link }
    const mount = mounted.current
    pending.current.set(url, launch)
    // Waits only once this computer's browser took Slack's page; a failed launch stays here, and
    // its page can be asked for again.
    void openSlackApprovalHere(url).then((opened) => {
      if (pending.current.get(url) === launch) {
        pending.current.delete(url)
      }
      if (!opened || mounted.current !== mount) {
        return
      }
      const { at: from, link } = launch
      // Checked against the step as it is when applied, so a Copy link in the same batch wins.
      // Recording the page is idempotent, so a repeated updater call changes nothing more.
      setStep((current) =>
        current === from
          ? { kind: 'waiting', teamId: from.teamId, ...remember(from.teamId, link), copied: false }
          : current
      )
    })
  }, [step, setStep, mounted, remember])
}
