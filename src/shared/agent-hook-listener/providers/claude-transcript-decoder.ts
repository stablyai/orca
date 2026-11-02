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
export type ClaudeTranscriptInput = {
  tokens?: Token[]
  next: number
  operation?: () => void
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

  private readonly finalInput: ClaudeTranscriptInput = { next: 0 }

  write(text: string, input: ClaudeTranscriptInput = { next: 0 }): void {
    if (text.length) {
      this.started = true
    }
    this.run(text, input)
  }

  end(): Record<string, unknown> | undefined {
    this.run(none, this.finalInput)
    return this.invalid ? undefined : this.value
  }

  private run(text: string | typeof none, input: ClaudeTranscriptInput): void {
    if (this.invalid) {
      return
    }
    if (!input.tokens) {
      const tokens: Token[] = []
      try {
        this.parse(text, (token: Token) => {
          tokens.push(token)
        })
        input.tokens = tokens
      } catch (error) {
        // Only native grammar rejection discards a frame; projection errors retain their checkpoint.
        if (
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
    while (input.next < input.tokens.length) {
      input.operation ??= this.prepare(input.tokens[input.next])
      this.consume(input.operation)
      input.operation = undefined
      input.next++
      this.tokens++
    }
  }

  private consume(operation: () => void): void {
    operation()
  }

  private target(): { scope: Scope; key: string } {
    const parent = this.stack.at(-1)
    return parent ? { scope: parent.scope, key: parent.key } : { scope: 'discard', key: '' }
  }

  private assignment(value: unknown): () => void {
    const parent = this.stack.at(-1)
    const key = parent?.key ?? ''
    return () => {
      if (parent && fields[parent.scope].includes(key)) {
        parent.object[key] = value
      }
    }
  }

  private prepare(token: Token): () => void {
    if (token.name === 'startKey' || token.name === 'startString' || token.name === 'startNumber') {
      const { scope, key } = this.target()
      const scalar =
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
      const parts: string[] = []
      return () => {
        this.scalar = scalar
        this.parts = parts
        this.head = ''
        this.nonblank = false
      }
    }
    if (token.name === 'stringChunk' || token.name === 'numberChunk') {
      if (this.scalar === 'selected') {
        const index = this.parts.length
        return () => {
          this.parts[index] = token.value
          this.parts.length = index + 1
        }
      }
      const head =
        this.scalar === 'text'
          ? this.head + token.value.slice(0, Math.max(0, 320 - this.head.length))
          : this.scalar === 'key'
            ? (this.head + token.value).slice(0, 32)
            : this.head
      const nonblank = this.nonblank || (this.scalar === 'text' && token.value.trim() !== '')
      return () => {
        this.head = head
        this.nonblank = nonblank
      }
    }
    if (token.name === 'endKey') {
      const parent = this.stack.at(-1)
      const key = parent && fields[parent.scope].includes(this.head) ? this.head : ''
      return () => {
        if (parent) {
          parent.key = key
        }
        this.head = ''
      }
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
      const assign = this.assignment(value)
      const parts: string[] = []
      return () => {
        assign()
        this.parts = parts
        this.head = ''
      }
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
      const frame: Frame = { scope: next, key: '', object: {}, facts: [], text: false }
      const index = this.stack.length
      return () => {
        this.stack[index] = frame
        this.stack.length = index + 1
      }
    }
    if (token.name === 'endObject' || token.name === 'endArray') {
      const index = this.stack.length - 1
      const frame = this.stack[index]
      const parent = this.stack[index - 1]
      const key = parent?.key ?? ''
      const factIndex = parent?.facts.length ?? 0
      const textIndex = frame.facts.length
      const textFact = { type: 'text', text: 'x' }
      return () => {
        this.stack.length = index
        if (frame.scope === 'root') {
          this.value = frame.object
        } else if (frame.scope === 'block' && parent?.scope === 'content') {
          if (frame.object.type === 'tool_use' || frame.object.type === 'tool_result') {
            parent.facts[factIndex] = frame.object
            parent.facts.length = factIndex + 1
          } else if (frame.object.type === 'text' && frame.object.text === 'x') {
            parent.text = true
          }
        } else if (parent && fields[parent.scope].includes(key)) {
          if (frame.scope === 'content' && frame.text) {
            frame.facts[textIndex] = textFact
            frame.facts.length = textIndex + 1
          }
          parent.object[key] =
            frame.scope === 'content'
              ? frame.facts
              : frame.scope === 'discard'
                ? undefined
                : frame.object
        }
      }
    }
    if (token.name === 'trueValue' || token.name === 'falseValue' || token.name === 'nullValue') {
      return this.assignment(token.value)
    }
    return () => {}
  }
}
