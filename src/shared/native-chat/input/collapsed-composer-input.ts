import { PASTED_CONTENT_PLACEHOLDER } from '../../agent-launch/startup/agent-prompt-injection'
import { IMAGE_PROMPT_MARKER } from '../transcript/native-chat-image-transcript-markers'

/** Claude's `[Pasted text #1 +29 lines]` beside the shared Codex paste and image markers. */
export const COLLAPSED_INPUT_LABEL = new RegExp(
  [
    /\[Pasted text #\d+[^\]]*\]/.source,
    PASTED_CONTENT_PLACEHOLDER.source,
    IMAGE_PROMPT_MARKER.source
  ].join('|')
)

/** A label stands for content the composer line cannot spell out. */
export function composerShowsCollapsedInput(line: string): boolean {
  return COLLAPSED_INPUT_LABEL.test(line)
}
