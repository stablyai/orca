import type { GlobalSettings } from '../../../shared/types'
import {
  BRACKETED_PASTE_END,
  BRACKETED_PASTE_START,
  normalizeTerminalPasteLineEndings,
  wrapTerminalBracketedPasteText
} from '@/components/terminal-pane/terminal-bracketed-paste'
import { sendRuntimePtyInputVerified } from '@/runtime/runtime-terminal-inspection'

// Why: bracketed paste markers let supported TUIs treat generated prompt text
// as one paste instead of echoing character-by-character or triggering edits.
export const AGENT_DRAFT_PASTE_DIRECT_MAX_BYTES = 64 * 1024
export const AGENT_DRAFT_PASTE_CHUNK_MAX_BYTES = 16 * 1024
export const AGENT_DRAFT_PASTE_MAX_BYTES = 16 * 1024 * 1024
const AGENT_DRAFT_PASTE_PREFLIGHT_YIELD_CODE_UNITS = 256 * 1024
const AGENT_DRAFT_PASTE_ESCAPE_CODE_POINT = 0x1b
const AGENT_DRAFT_PASTE_INERT_ESCAPE_CODE_POINT = 0x241b
const AGENT_DRAFT_PASTE_INERT_ESCAPE = '\u241b'

export type AgentDraftPtyInputWriter = (data: string) => boolean | Promise<boolean>

export async function sendAgentDraftPasteContent(
  settings: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined,
  ptyId: string,
  content: string,
  writePty?: AgentDraftPtyInputWriter
): Promise<boolean> {
  if (content.length > AGENT_DRAFT_PASTE_MAX_BYTES) {
    return false
  }

  const terminalContent = normalizeTerminalPasteLineEndings(content)
  const directMeasurement = measureSanitizedUtf8ByteLength(terminalContent, {
    stopAfterBytes: AGENT_DRAFT_PASTE_DIRECT_MAX_BYTES
  })
  if (!directMeasurement.exceededLimit) {
    return await writeAgentDraftPtyInput(
      settings,
      ptyId,
      wrapTerminalBracketedPasteText(terminalContent),
      writePty
    )
  }

  // Why: generated prompts can be paste-sized; yield during accepted-size
  // preflight before starting any PTY writes so the renderer is not pinned.
  if (await isSanitizedDraftPasteOverLimit(terminalContent, AGENT_DRAFT_PASTE_MAX_BYTES)) {
    return false
  }

  let bracketedPasteOpen = false
  for (const chunk of iterateAgentDraftPasteContentChunks(terminalContent)) {
    let accepted = false
    try {
      accepted = await writeAgentDraftPtyInput(settings, ptyId, chunk, writePty)
    } catch {
      if (bracketedPasteOpen && chunk !== BRACKETED_PASTE_END) {
        await closeAgentDraftBracketedPaste(settings, ptyId, writePty)
      }
      return false
    }
    if (!accepted) {
      if (bracketedPasteOpen && chunk !== BRACKETED_PASTE_END) {
        await closeAgentDraftBracketedPaste(settings, ptyId, writePty)
      }
      return false
    }
    if (chunk === BRACKETED_PASTE_START) {
      bracketedPasteOpen = true
    } else if (chunk === BRACKETED_PASTE_END) {
      bracketedPasteOpen = false
    }
  }
  return true
}

export function chunkAgentDraftPasteContent(
  content: string,
  maxChunkBytes = AGENT_DRAFT_PASTE_CHUNK_MAX_BYTES
): string[] {
  return [...iterateAgentDraftPasteContentChunks(content, maxChunkBytes)]
}

export function* iterateAgentDraftPasteContentChunks(
  content: string,
  maxChunkBytes = AGENT_DRAFT_PASTE_CHUNK_MAX_BYTES
): Generator<string> {
  const safeMaxChunkBytes = Math.max(4, maxChunkBytes)
  yield BRACKETED_PASTE_START
  // Why: normalize the complete draft before chunking so a CRLF pair cannot
  // straddle chunks and leak its LF half to a Windows ConPTY agent.
  const terminalContent = normalizeTerminalPasteLineEndings(content)
  let chunk = ''
  let chunkBytes = 0

  for (let index = 0; index < terminalContent.length; index += 1) {
    const codePoint = terminalContent.codePointAt(index) ?? 0
    const codeUnitLength = codePoint > 0xffff ? 2 : 1
    const sanitizedEscape = codePoint === AGENT_DRAFT_PASTE_ESCAPE_CODE_POINT
    const sanitized = sanitizedEscape
      ? AGENT_DRAFT_PASTE_INERT_ESCAPE
      : terminalContent.slice(index, index + codeUnitLength)
    const characterBytes = getUtf8ByteLengthForCodePoint(
      sanitizedEscape ? AGENT_DRAFT_PASTE_INERT_ESCAPE_CODE_POINT : codePoint
    )
    if (chunk && chunkBytes + characterBytes > safeMaxChunkBytes) {
      yield chunk
      chunk = sanitized
      chunkBytes = characterBytes
      continue
    }
    chunk += sanitized
    chunkBytes += characterBytes
    if (codeUnitLength === 2) {
      index += 1
    }
  }

  if (chunk) {
    yield chunk
  }
  yield BRACKETED_PASTE_END
}

type SanitizedDraftPasteByteMeasurement = {
  byteLength: number
  exceededLimit: boolean
}

function measureSanitizedUtf8ByteLength(
  content: string,
  options: { stopAfterBytes?: number } = {}
): SanitizedDraftPasteByteMeasurement {
  let byteLength = 0
  const stopAfterBytes = options.stopAfterBytes
  for (let index = 0; index < content.length; index += 1) {
    const codePoint = content.codePointAt(index) ?? 0
    byteLength += getSanitizedUtf8ByteLengthForCodePoint(codePoint)
    if (Number.isFinite(stopAfterBytes) && byteLength > (stopAfterBytes ?? 0)) {
      return { byteLength, exceededLimit: true }
    }
    if (codePoint > 0xffff) {
      index += 1
    }
  }
  return { byteLength, exceededLimit: false }
}

async function isSanitizedDraftPasteOverLimit(content: string, maxBytes: number): Promise<boolean> {
  let byteLength = 0
  let nextYieldAt = AGENT_DRAFT_PASTE_PREFLIGHT_YIELD_CODE_UNITS
  for (let index = 0; index < content.length; index += 1) {
    const codePoint = content.codePointAt(index) ?? 0
    byteLength += getSanitizedUtf8ByteLengthForCodePoint(codePoint)
    if (byteLength > maxBytes) {
      return true
    }
    if (codePoint > 0xffff) {
      index += 1
    }
    if (index >= nextYieldAt) {
      await yieldToAgentDraftPastePreflight()
      nextYieldAt = index + AGENT_DRAFT_PASTE_PREFLIGHT_YIELD_CODE_UNITS
    }
  }
  return false
}

function getSanitizedUtf8ByteLengthForCodePoint(codePoint: number): number {
  return getUtf8ByteLengthForCodePoint(
    codePoint === AGENT_DRAFT_PASTE_ESCAPE_CODE_POINT
      ? AGENT_DRAFT_PASTE_INERT_ESCAPE_CODE_POINT
      : codePoint
  )
}

function getUtf8ByteLengthForCodePoint(codePoint: number): number {
  if (codePoint <= 0x7f) {
    return 1
  }
  if (codePoint <= 0x7ff) {
    return 2
  }
  if (codePoint <= 0xffff) {
    return 3
  }
  return 4
}

function yieldToAgentDraftPastePreflight(): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, 0))
}

async function writeAgentDraftPtyInput(
  settings: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined,
  ptyId: string,
  data: string,
  writePty?: AgentDraftPtyInputWriter
): Promise<boolean> {
  return writePty ? await writePty(data) : await sendRuntimePtyInputVerified(settings, ptyId, data)
}

async function closeAgentDraftBracketedPaste(
  settings: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined,
  ptyId: string,
  writePty?: AgentDraftPtyInputWriter
): Promise<void> {
  try {
    // Why: once the opener reached the PTY, a failed content chunk should not
    // leave the target TUI in bracketed-paste mode.
    await writeAgentDraftPtyInput(settings, ptyId, BRACKETED_PASTE_END, writePty)
  } catch {
    // The original write already failed; callers only need the paste to fail closed.
  }
}
