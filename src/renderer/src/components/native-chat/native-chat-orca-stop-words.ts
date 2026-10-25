import { translate } from '@/i18n/i18n'
import type { AgentSessionOrcaStopCause } from '../../../../shared/agent-session-orca-stop'
import { joinSentences } from '../../../../shared/sentence-joining'

const STOPPED: Record<AgentSessionOrcaStopCause, (machine: string) => string> = {
  update: (machine) =>
    translate(
      'components.native-chat.notices.orcaStopUpdate',
      'Orca on {{machine}} restarted for an update while this response was in progress.',
      { machine }
    ),
  quit: (machine) =>
    translate(
      'components.native-chat.notices.orcaStopQuit',
      'Orca on {{machine}} was closed while this response was in progress.',
      { machine }
    ),
  crash: (machine) =>
    translate(
      'components.native-chat.notices.orcaStopCrash',
      'Orca on {{machine}} stopped unexpectedly while this response was in progress.',
      { machine }
    )
}

// A remote graceful stop is a server stop or a shared desktop's quit; "stopped" is true of both.
const remoteQuit = (machine: string): string =>
  translate(
    'components.native-chat.notices.orcaStopRemote',
    'Orca on {{machine}} stopped while this response was in progress.',
    { machine }
  )

function stoppedSentence(
  cause: AgentSessionOrcaStopCause,
  machine: string,
  remoteHost: boolean
): string {
  return cause === 'quit' && remoteHost ? remoteQuit(machine) : STOPPED[cause](machine)
}

/** Base wording on host continuation support so the sentence stays stable as the button changes. */
export function nativeChatOrcaStopRowText(
  cause: AgentSessionOrcaStopCause,
  machine: string,
  options: { continueAvailable: boolean; remoteHost: boolean }
): string {
  const stopped = stoppedSentence(cause, machine, options.remoteHost)
  return options.continueAvailable
    ? stopped
    : joinSentences([
        stopped,
        translate(
          'components.native-chat.notices.orcaStopCanContinue',
          'You can continue in this conversation.'
        )
      ])
}
