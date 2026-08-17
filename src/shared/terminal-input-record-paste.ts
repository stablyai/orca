import { isTuiAgent, TUI_AGENT_CONFIG } from './tui-agent-config'

export type WindowsInputRecordPasteNewline = 'alt-enter' | 'csi-u'

export function resolveWindowsInputRecordPasteNewline(
  hostPlatform: NodeJS.Platform | null | undefined,
  agent: unknown
): WindowsInputRecordPasteNewline | undefined {
  if (hostPlatform !== 'win32' || !isTuiAgent(agent)) {
    return undefined
  }
  return TUI_AGENT_CONFIG[agent].windowsInputRecordPasteNewline
}

export function encodeWindowsInputRecordPasteText(
  text: string,
  newline: WindowsInputRecordPasteNewline
): string {
  const newlineSequence = newline === 'csi-u' ? '\x1b[13;2u' : '\x1b\r'
  let encoded = ''
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (char === '\r') {
      encoded += newlineSequence
      if (text[index + 1] === '\n') {
        index += 1
      }
    } else if (char === '\n') {
      encoded += newlineSequence
    } else {
      encoded += char === '\x1b' ? '\u241b' : char
    }
  }
  return encoded
}
