import type { NativeChatMessage } from '../../../../../../shared/native-chat/native-chat-types'
import type { NativeChatTurnStatus } from '../../../../../../shared/native-chat/transcript/native-chat-turn-status'
import type { NativeChatResolvedPrompt } from '../../../../../../shared/native-chat/native-chat-resolution-receipt'
import type { NativeChatTurnDiff } from '../../../../../../shared/native-chat/tools/native-chat-turn-diffs'
import type { NativeChatOpenedPullRequest } from '../../../../../../shared/native-chat/tools/native-chat-opened-pull-requests'
import type { NativeChatRowTypography } from '../../viewport/virtualization/native-chat-row-height-estimate'
import type { NativeChatSideChatForkOffer } from '../../messages/actions/native-chat-side-chat-fork-point'
import type { NativeChatSubagentHead } from '../../subagents/native-chat-subagent-scope'

import type { NativeChatMarkdownImageSources } from '../../../../../../shared/native-chat/transcript/native-chat-generated-image-answers'

export type NativeChatTranscriptSlotsInput = {
  imageSources?: NativeChatMarkdownImageSources
  messages: readonly NativeChatMessage[]
  unresolvedRowIds?: ReadonlySet<string>
  typography?: NativeChatRowTypography
  turnKeys: readonly (string | undefined)[]
  /** The current turn owns the running clock and live rows; undefined before a turn opens. */
  liveTurnKey: string | undefined
  receipts: ReadonlyMap<string, NativeChatResolvedPrompt>
  turnStatuses: {
    active: NativeChatTurnStatus | null
    completedByTurn: Readonly<Record<string, NativeChatTurnStatus>>
  }
  turnDiffs: ReadonlyMap<string, NativeChatTurnDiff>
  openedPullRequests?: ReadonlyMap<string, readonly NativeChatOpenedPullRequest[]>
  /** Turns the reader opened. Everything else with a duration stays folded. */
  expandedTurnKeys: ReadonlySet<string>
  isWorking: boolean
  /** Session-level lifecycle, which outlives a transcript that never said "done". */
  lifecycleWorking: boolean
  /** Only where `/btw` listens: find the newest response that offers Fork. */
  forkOffer?: NativeChatSideChatForkOffer
  /** Subagents no roster row in this transcript names, each drawn as a head at its first row. */
  subagentHeads?: readonly NativeChatSubagentHead[]
  /** The open reasoning block the live activity line discloses: its row takes no slot meanwhile. */
  liveReasoningId?: string | null
}
