// Fold a long agent reply into something a speaker can actually say.
//
// Ported from `mobile/src/voice/summarize-for-speech.ts` — same operator
// decision (summarize, 2026-07-21) and the same arm/ceiling reasoning. A coding
// agent's turn-end message is routinely hundreds of words of paths, hashes and
// command output; read verbatim that is minutes of unusable monologue. The full
// text stays on screen — this only decides what is SPOKEN.
//
// Collab boards (G2-P): the same pipeline speaks doodle-turn replies. Strip
// inject echoes first (prepareReplyForSpeech) and use a prompt that covers
// visual/board turns, not only "files changed".

import { meshVoiceBaseUrlFor, SUMMARY_MODEL } from './mesh-speech-config'
import { prepareReplyForSpeech } from './prepare-reply-for-speech'

const MAX_SUMMARY_TOKENS = 1600

/** Replies shorter than this are already speakable and skip the round trip
 *  entirely, keeping quick answers instant. */
export const SPEAK_VERBATIM_UNDER_CHARS = 220

/** Cap the prompt: a giant reply would push the arm's context and buy nothing,
 *  since the summary only needs the shape of the turn. */
const MAX_INPUT_CHARS = 6000

const SYSTEM_PROMPT = [
  "You compress an agent's reply into something spoken aloud to the operator.",
  'Two or three short sentences, maximum.',
  'Plain spoken English: no markdown, no lists, no code fences, no file paths,',
  'no commit hashes, no URLs, no board UUIDs, no shape ids — they are unlistenable.',
  'Lead with what matters: the outcome, the answer, or what the agent saw.',
  'If the reply is about a whiteboard sketch, doodle, diagram, or collab board,',
  'say what the agent understood from the drawing and what it proposes next.',
  'If it is a normal coding turn, say what got done and whether anything failed',
  'or needs the operator. Say "it failed" plainly if it failed.',
  'Ignore system notices, tool-availability pings, and paste metadata.',
  'Do not invent detail that is not in the reply, and do not add pleasantries.'
].join(' ')

/**
 * Fold a long agent reply into a spoken-length summary. Returns the original
 * text unchanged when it is already short enough to speak, and throws on
 * transport failure so the caller can decide whether to fall back to the raw
 * reply rather than go silent.
 */
export async function summarizeForSpeech(
  reply: string,
  options: { hostEndpoint?: string | null; signal?: AbortSignal } = {}
): Promise<string> {
  const { hostEndpoint, signal } = options
  const text = prepareReplyForSpeech(reply)
  if (!text) {
    throw new Error('summary empty after prepare')
  }
  // Mobile parity: short clean answers skip the local model (faster, less drift).
  if (text.length <= SPEAK_VERBATIM_UNDER_CHARS) {
    return text
  }
  const res = await fetch(`${meshVoiceBaseUrlFor(hostEndpoint)}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal,
    body: JSON.stringify({
      model: SUMMARY_MODEL,
      max_tokens: MAX_SUMMARY_TOKENS,
      temperature: 0.2,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: text.slice(0, MAX_INPUT_CHARS) }
      ]
    })
  })
  if (!res.ok) {
    throw new Error(`summary ${res.status}`)
  }
  const data = (await res.json()) as {
    choices?: { message?: { content?: string } }[]
  }
  const summary = data.choices?.[0]?.message?.content?.trim()
  // An empty summary is worse than the raw reply — fall back rather than speak
  // nothing.
  return summary && summary.length > 0 ? stripThinking(summary) : text
}

/** Every Config A arm emits chain-of-thought first and suppression is
 *  impossible on this stack, so a stray <think> block must be stripped before
 *  it is spoken — otherwise the pet reads its own monologue aloud. */
function stripThinking(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim() || text.trim()
}
