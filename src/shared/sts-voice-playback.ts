import type { NativeChatMessage } from './native-chat-types'

export function localVoiceForLanguage<
  T extends { localService: boolean; lang: string; voiceURI?: string }
>(voices: readonly T[], language: string, preferredUri?: string): T | undefined {
  const tag = language.toLowerCase().replaceAll('_', '-')
  const local = voices.filter(
    (voice) => voice.localService && voice.lang.toLowerCase().split(/[-_]/)[0] === tag.split('-')[0]
  )
  return (
    (preferredUri ? local.find((voice) => voice.voiceURI === preferredUri) : undefined) ??
    local.find((voice) => voice.lang.toLowerCase().replaceAll('_', '-') === tag) ??
    local.find((voice) => voice.lang.toLowerCase().split(/[-_]/)[0] === tag.split('-')[0])
  )
}

export function voiceMessageText(message: NativeChatMessage): string {
  if (message.role !== 'assistant' || message.agentId) {
    return ''
  }
  return message.blocks
    .filter((block) => block.type === 'text' && !block.presentation && !block.failure)
    .map((block) => (block.type === 'text' ? block.text : ''))
    .join('\n')
}

export function spokenProse(text: string): string {
  return text
    .replace(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)/g, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/^[ \t]*[>#*+-]+[ \t]+/gm, '')
    .replace(/[`*_]/g, '')
    .trim()
}

export class StsVoicePlayback {
  private consumed = new Map<string, string>()
  private boundary = { sequence: -1, index: -1 }

  reset(messages: readonly NativeChatMessage[]): void {
    this.consumed.clear()
    this.boundary = { sequence: -1, index: -1 }
    for (const message of messages) {
      this.consumed.set(message.id, spokenProse(voiceMessageText(message)))
      const position = message.journalPosition
      if (position && this.afterBoundary(position)) {
        this.boundary = position
      }
    }
  }

  next(messages: readonly NativeChatMessage[], working: boolean): string | null {
    return this.findNext(messages, working, true)
  }

  hasPending(messages: readonly NativeChatMessage[], working: boolean): boolean {
    return this.findNext(messages, working, false) !== null
  }

  private findNext(
    messages: readonly NativeChatMessage[],
    working: boolean,
    commit: boolean
  ): string | null {
    for (const message of messages) {
      if (message.journalPosition && !this.afterBoundary(message.journalPosition)) {
        continue
      }
      const text = spokenProse(voiceMessageText(message))
      const consumed = this.consumed.get(message.id) ?? ''
      if (!text.startsWith(consumed)) {
        if (commit) {
          this.consumed.set(message.id, text)
        }
        continue
      }
      const rest = text.slice(consumed.length)
      if (!rest.trim()) {
        continue
      }
      const leading = rest.length - rest.trimStart().length
      const boundary = /[.!?。！？](?:\s|$)|\n/.exec(rest.slice(leading))
      const complete = message.state === 'completed' || !working
      let end = boundary
        ? leading + boundary.index + boundary[0].length
        : complete
          ? rest.length
          : 0
      if (rest.length > 220 && (end === 0 || end > 220)) {
        const space = rest.lastIndexOf(' ', 220)
        end = space > 80 ? space + 1 : 220
        if (/[\uD800-\uDBFF]/.test(rest[end - 1])) {
          end -= 1
        }
      }
      if (end === 0) {
        return null
      }
      if (commit) {
        this.consumed.set(message.id, text.slice(0, consumed.length + end))
      }
      return rest.slice(0, end).trim()
    }
    return null
  }

  private afterBoundary(position: { sequence: number; index: number }): boolean {
    return (
      position.sequence > this.boundary.sequence ||
      (position.sequence === this.boundary.sequence && position.index > this.boundary.index)
    )
  }
}
