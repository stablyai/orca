// Fold a long agent reply into something a speaker can actually say.
//
// Ported from `mobile/src/voice/summarize-for-speech.ts` — same operator
// decision (summarize, 2026-07-21) and the same arm/ceiling reasoning. A coding
// agent's turn-end message is routinely hundreds of words of paths, hashes and
// command output; read verbatim that is minutes of unusable monologue. The full
// text stays on screen — this only decides what is SPOKEN.

import { meshVoiceBaseUrlFor, SUMMARY_MODEL } from './mesh-speech-config'

const MAX_SUMMARY_TOKENS = 1600

/** Replies shorter than this are already speakable and skip the round trip
 *  entirely, keeping quick answers instant. */
export const SPEAK_VERBATIM_UNDER_CHARS = 220

/** Cap the prompt: a giant reply would push the arm's context and buy nothing,
 *  since the summary only needs the shape of the turn. */
const MAX_INPUT_CHARS = 6000

const SYSTEM_PROMPT = [
  "You compress a coding agent's reply into something spoken aloud to the",
  'operator who asked for it. Two or three short sentences, maximum.',
  'Plain spoken English: no markdown, no lists, no code, no file paths, no',
  'commit hashes, no URLs — they are unlistenable read out loud.',
  'Lead with the outcome: what got done, and whether anything failed or needs',
  'the operator. Say "it failed" plainly if it failed. Do not invent detail',
  'that is not in the reply, and do not add pleasantries.'
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
  const text = reply.trim()
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
