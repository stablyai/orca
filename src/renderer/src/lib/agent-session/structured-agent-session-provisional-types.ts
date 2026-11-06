import type {
  AgentSessionLaunchPlan,
  AgentSessionLaunchTarget
} from '@/lib/agent-session-launch-plan'
import type { StructuredAgentLaunchHooks } from '@/lib/structured-agent-launch-settlement'
import type { NativeChatComposerFocusIntent } from '@/components/native-chat/use-native-chat-composer-reveal-focus'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import type {
  DeclinedStructuredLaunchTerminalOptions,
  StructuredLaunchTerminal
} from './launch/structured-agent-session-launch-admission'

export type PreparedProvisionalTab = {
  targetGroupId: string
  index?: number
  release: () => void
}

export type ProvisionalLaunchArgs = {
  plan: AgentSessionLaunchPlan
  hooks: StructuredAgentLaunchHooks
  focusIntent?: NativeChatComposerFocusIntent
  target?: AgentSessionLaunchTarget
  targetGroupId?: string
  afterTabId?: string
  index?: number
  /** Resolve against the current layout after host admission, before creating the launch. */
  prepareTab?: () => PreparedProvisionalTab | null | undefined
  activate?: boolean
  /** Identity-only resumes publish on commit; unknown outcomes keep their recovery tab. */
  deferPublication?: true
  /** Allow workspace reveal before host acquisition, when the launch has no session ID or owned chat tab yet. */
  beforeOpen?: (sessionId?: string) => boolean | void
  /** The published tab, or null when the layout owner refuses or the launch ends without a chat. */
  onTabOpenSettled?: (tabId: string | null, reason?: 'layout-refused') => void
  /** The terminal the host's "no" opens; a caller without one gets a new agent tab's. */
  onHostDeclined?: (
    target: RuntimeClientTarget,
    activate?: false
  ) => Promise<StructuredLaunchTerminal> | StructuredLaunchTerminal
  /** What that default terminal carries from the caller, e.g. a recipe's saved CLI arguments. */
  declinedTerminal?: DeclinedStructuredLaunchTerminalOptions
  /** `onHostDeclined` opens a surface of the caller's own (a shell) rather than the agent's CLI. */
  declinedOpensCallerSurface?: true
  /** The caller already asked the host whether another terminal runs the resumed conversation. */
  resumeWritersChecked?: true
}
