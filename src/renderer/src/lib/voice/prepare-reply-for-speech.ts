/**
 * Clean an agent turn text before the local summary model sees it.
 *
 * Speak-back only gets `lastAssistantMessage`. After collab inject, that field
 * often still carries the operator paste (board ids, shape digests, atlas
 * paths) or MCP tool-awareness chatter. LFM then "summarizes" protocol noise
 * and the spoken result has zero clue about the actual answer.
 */

/** Strip collab inject / awareness blobs that leaked into the assistant field. */
export function stripCollabInjectEcho(text: string): string {
  let out = text
  // New operator framing (G2-P atlas fix)
  out = out.replace(
    /OPERATOR\s*[—\-]\s*collab board selection[\s\S]*?End of collab board selection[^\n]*/gi,
    '\n'
  )
  out = out.replace(
    /OPERATOR\s*[—\-]\s*collab board is open beside this terminal\.[\s\S]*?(?:\n\n|$)/gi,
    '\n'
  )
  // Legacy system-notice framing (full blocks)
  out = out.replace(/\[collab-canvas awareness\][\s\S]*?---\s*end collab-canvas awareness\s*---/gi, '\n')
  out = out.replace(/\[collab-canvas\][\s\S]*?---\s*end collab-canvas\s*---/gi, '\n')
  // Orphan markers when awareness+inject were pasted back-to-back
  out = out.replace(/---\s*end collab-canvas awareness\s*---/gi, '\n')
  out = out.replace(/---\s*end collab-canvas\s*---/gi, '\n')
  out = out.replace(/\[collab-canvas awareness\]/gi, '')
  out = out.replace(/\[collab-canvas\]/gi, '')
  // Metadata lines that commonly leak without the full block
  out = out.replace(
    /^\s*(board|worktree|shapes|bounds|atlas|board id|selected shapes|sketch image)\s*:[^\n]*$/gim,
    ''
  )
  out = out.replace(/^\s*draw:shape:[^\n]*$/gim, '')
  out = out.replace(/^\s*---\s*selection digest\s*---\s*$/gim, '')
  return out
}

/** Drop mesh MCP / xd:// first-use doc dumps that are not operator-facing answers. */
export function stripToolAwarenessNoise(text: string): string {
  let out = text
  // Whole "system-notice about a new tool" monologue up to a blank line + real prose
  out = out.replace(
    /The user has sent a system[- ]notice about a new tool[\s\S]*?(?:\n\s*\n|$)/gi,
    '\n'
  )
  // Bare xd:// tool refs and "Read xd://..." lines
  out = out.replace(/^\s*Read xd:\/\/[^\n]*$/gim, '')
  out = out.replace(/xd:\/\/mcp__[a-z0-9_]+/gi, '')
  // Common first-use filler after tool notices
  out = out.replace(
    /^\s*(Let me read the docs[^\n]*|Noted\. The xd:\/\/ device inventory[\s\S]*?internalized\.)\s*$/gim,
    ''
  )
  return out
}

/**
 * Prefer the last substantial paragraph when the payload is inject+reply
 * glued together. Agents often leave the operator paste above their answer.
 */
export function preferTrailingAnswer(text: string): string {
  const trimmed = text.trim()
  if (trimmed.length < 80) {
    return trimmed
  }
  const parts = trimmed
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
  if (parts.length < 2) {
    return trimmed
  }
  const last = parts[parts.length - 1] ?? trimmed
  // Prefer last block when earlier blocks still look like collab/tool metadata.
  const earlier = parts.slice(0, -1).join('\n')
  if (
    /board id:|selected shapes:|sketch image|draw:shape:|OPERATOR\s*[—\-]\s*collab|system-notice|xd:\/\//i.test(
      earlier
    )
  ) {
    // Only switch if last block is real prose (not another meta crumb).
    if (last.length >= 24 && !/^(board|shapes|atlas)\s*:/i.test(last)) {
      return last
    }
  }
  return trimmed
}

/** Full pipeline: strip noise → prefer trailing answer → normalize whitespace. */
export function prepareReplyForSpeech(reply: string): string {
  let text = reply.replace(/\r\n/g, '\n')
  text = stripCollabInjectEcho(text)
  text = stripToolAwarenessNoise(text)
  text = preferTrailingAnswer(text)
  text = text
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return text
}
