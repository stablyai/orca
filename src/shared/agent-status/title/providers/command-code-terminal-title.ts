// Command Code titles its tab `⌘ <session> · <model>` (`█` without Unicode) and never shows its turn there.
const COMMAND_CODE_TITLE_RE = /^[\u2318\u2588] /u

/** Idle while its own title is up and its composer has shown idle since its last turn, in a pane
 *  known to run Command Code. */
export function commandCodePaneTitleStatus(
  title: string,
  agent: string | null | undefined,
  composerIdle: boolean
): 'idle' | null {
  return composerIdle && agent === 'command-code' && COMMAND_CODE_TITLE_RE.test(title)
    ? 'idle'
    : null
}
