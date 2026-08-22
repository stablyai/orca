const SESSION_CONTEXT_BLOCK_PATTERN =
  /<(user_info|user_rules|environment_context|app-context|skills_instructions|permissions instructions|collaboration_mode|apps_instructions|plugins_instructions|recommended_plugins)\b[^>]*>[\s\S]*?<\/\1\s*>/gi
const RULES_CONTEXT_PREAMBLE_PATTERN =
  /The rules section has a number of possible rules\/memories\/context[\s\S]*?contents of the subsection\.\s*/i

export type NativeChatContextDisclosure = {
  visibleText: string
  contextText: string
  contextSectionCount: number
}

/**
 * Separates transport/session metadata from the human-authored part of a user
 * turn. The metadata remains available behind disclosure instead of dominating
 * the conversation transcript.
 */
export function splitNativeChatSessionContext(text: string): NativeChatContextDisclosure {
  const contextSections = Array.from(text.matchAll(SESSION_CONTEXT_BLOCK_PATTERN), (match) =>
    match[0].trim()
  )
  if (contextSections.length === 0) {
    return { visibleText: text, contextText: '', contextSectionCount: 0 }
  }

  const visibleText = text
    .replace(RULES_CONTEXT_PREAMBLE_PATTERN, '')
    .replace(SESSION_CONTEXT_BLOCK_PATTERN, '\n\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

  return {
    visibleText,
    contextText: contextSections.join('\n\n'),
    contextSectionCount: contextSections.length
  }
}
