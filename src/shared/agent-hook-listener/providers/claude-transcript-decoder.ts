import parser, { type Token } from 'stream-json/core/parser.js'
import exec from 'stream-chain/exec.js'
import { none } from 'stream-chain/defs.js'
import { isKnownHarnessInjectedUserTurnText } from '../../harness-injected-user-turns'

type Scope = 'root' | 'message' | 'content' | 'block' | 'result' | 'discard'
type Frame = {
  scope: Scope
  key: string
  object: Record<string, unknown>
  facts: Record<string, unknown>[]
  text: boolean
}
const fields: Record<Scope, readonly string[]> = {
  root: ['type', 'subtype', 'timestamp', 'isMeta', 'isCompactSummary', 'message', 'toolUseResult'],
  message: ['content'],
  block: ['type', 'name', 'id', 'tool_use_id', 'is_error', 'text'],
  result: ['isAsync', 'agentId'],
  content: [],
  discard: []
}

/** A frame is provisional until grammar finalization AND its physical LF. */
export class ClaudeTranscriptDecoder {
  private readonly parse = exec(parser({ packValues: false }))
  private readonly stack: Frame[] = []
  private scalar: 'key' | 'text' | 'selected' | 'discard' = 'discard'
  private parts: string[] = []
  private head = ''
  private nonblank = false
  private value: Record<string, unknown> | undefined
  private invalid = false
  private started = false
  private tokens = 0

  get work(): number {
    return this.tokens
  }

  get unfinished(): boolean {
    return this.started
  }

  write(text: string): void {
    if (text.length) {
      this.started = true
    }
    this.run(text)
  }

  end(): Record<string, unknown> | undefined {
    this.run(none)
    return this.invalid ? undefined : this.value
  }

  private run(text: string | typeof none): void {
    if (this.invalid) {
      return
    }
    let consumerFailed = false
    try {
      const pending = this.parse(text, (token: Token) => {
        try {
          this.consume(token)
        } catch (error) {
          consumerFailed = true
          throw error
        }
      })
      if (pending) {
        throw new Error('Claude JSON decoding requires synchronous tokens')
      }
    } catch (error) {
      // Only the grammar's syntax errors can discard a frame; capacity/consumer failure propagates.
      if (
        !consumerFailed &&
        error instanceof Error &&
        error.constructor === Error &&
        (error.message.startsWith('Parser cannot parse input:') ||
          error.message.startsWith('Parser has expected'))
      ) {
        this.invalid = true
        this.stack.length = 0
        this.parts = []
        this.head = ''
        this.value = undefined
        return
      }
      throw error
    }
  }

  private target(): { scope: Scope; key: string } {
    const parent = this.stack.at(-1)
    return parent ? { scope: parent.scope, key: parent.key } : { scope: 'discard', key: '' }
  }

  private assign(value: unknown): void {
    const parent = this.stack.at(-1)
    if (parent && fields[parent.scope].includes(parent.key)) {
      parent.object[parent.key] = value
    }
  }

  private consume(token: Token): void {
    this.tokens++
    if (token.name === 'startKey' || token.name === 'startString' || token.name === 'startNumber') {
      const { scope, key } = this.target()
      this.scalar =
        token.name === 'startKey'
          ? 'key'
          : token.name === 'startNumber'
            ? 'discard'
            : (scope === 'block' && key === 'text') || (scope === 'message' && key === 'content')
              ? 'text'
              : ['type', 'subtype', 'timestamp', 'name', 'id', 'tool_use_id', 'agentId'].includes(
                    key
                  ) && fields[scope].includes(key)
                ? 'selected'
                : 'discard'
      this.parts = []
      this.head = ''
      this.nonblank = false
      return
    }
    if (token.name === 'stringChunk' || token.name === 'numberChunk') {
      if (this.scalar === 'selected') {
        this.parts.push(token.value)
      } else if (this.scalar === 'text') {
        this.head += token.value.slice(0, Math.max(0, 320 - this.head.length))
        this.nonblank ||= token.value.trim() !== ''
      } else if (this.scalar === 'key') {
        // All recognized keys fit this window; long unknown keys must never match a prefix.
        this.head = (this.head + token.value).slice(0, 32)
      }
      return
    }
    if (token.name === 'endKey') {
      const parent = this.stack.at(-1)
      if (parent) {
        parent.key = fields[parent.scope].includes(this.head) ? this.head : ''
      }
      this.head = ''
      return
    }
    if (token.name === 'endString' || token.name === 'endNumber') {
      const value =
        this.scalar === 'selected'
          ? this.parts.join('')
          : this.scalar === 'text' &&
              this.nonblank &&
              !isKnownHarnessInjectedUserTurnText(this.head)
            ? 'x'
            : undefined
      this.assign(value)
      this.parts = []
      this.head = ''
      return
    }
    if (token.name === 'startObject' || token.name === 'startArray') {
      const { scope, key } = this.target()
      const next: Scope =
        !this.stack.length && token.name === 'startObject'
          ? 'root'
          : scope === 'root' && key === 'message' && token.name === 'startObject'
            ? 'message'
            : scope === 'root' && key === 'toolUseResult' && token.name === 'startObject'
              ? 'result'
              : scope === 'message' && key === 'content' && token.name === 'startArray'
                ? 'content'
                : scope === 'content' && token.name === 'startObject'
                  ? 'block'
                  : 'discard'
      this.stack.push({ scope: next, key: '', object: {}, facts: [], text: false })
      return
    }
    if (token.name === 'endObject' || token.name === 'endArray') {
      const frame = this.stack.pop()!
      const parent = this.stack.at(-1)
      if (frame.scope === 'root') {
        this.value = frame.object
      } else if (frame.scope === 'block' && parent?.scope === 'content') {
        if (frame.object.type === 'tool_use' || frame.object.type === 'tool_result') {
          parent.facts.push(frame.object)
        } else if (frame.object.type === 'text' && frame.object.text === 'x') {
          parent.text = true
        }
      } else if (frame.scope === 'content') {
        if (frame.text) {
          frame.facts.push({ type: 'text', text: 'x' })
        }
        this.assign(frame.facts)
      } else {
        this.assign(frame.scope === 'discard' ? undefined : frame.object)
      }
      return
    }
    if (token.name === 'trueValue' || token.name === 'falseValue' || token.name === 'nullValue') {
      this.assign(token.value)
    }
  }
}
