import { ownRetainedString } from '../text/own-retained-string'

export type NdjsonLargeRecordParser = {
  minCodeUnits: number
  create: () => { write: (text: string) => void; end: () => unknown }
}

type ParsedRecord =
  | { kind: 'empty' }
  | { kind: 'record'; value: unknown; line: string }
  | { kind: 'invalid'; error: Error; line: string }

export function createNdjsonRecordAssembly(large?: NdjsonLargeRecordParser) {
  let segments: string[] = []
  let codeUnits = 0
  let hasContent = false
  let parser: ReturnType<NdjsonLargeRecordParser['create']> | null = null
  let error: Error | null = null
  let prefix = ''
  return {
    write(text: string) {
      codeUnits += text.length
      hasContent ||= /\S/.test(text)
      try {
        if (!parser && !error && large && codeUnits >= large.minCodeUnits) {
          // At most 48 KiB of UTF-8, including an unpaired surrogate at the cut.
          prefix = ownRetainedString((segments[0] ?? text).slice(0, 16 * 1024))
          parser = large.create()
          for (const segment of segments) {
            parser.write(segment)
          }
          segments = []
        }
        if (parser) {
          parser.write(text)
        } else if (!error) {
          segments.push(text)
        }
      } catch (failure) {
        error = failure instanceof Error ? failure : new Error(String(failure))
        parser = null
        segments = []
      }
    },
    finish(acceptLine?: (line: string) => boolean): ParsedRecord {
      if (!hasContent) {
        return { kind: 'empty' }
      }
      const line =
        parser || error ? prefix : segments.length === 1 ? segments[0] : segments.join('')
      if (acceptLine && !acceptLine(line)) {
        return { kind: 'empty' }
      }
      try {
        if (error) {
          throw error
        }
        return { kind: 'record', value: parser ? parser.end() : JSON.parse(line), line }
      } catch (failure) {
        return {
          kind: 'invalid',
          error: failure instanceof Error ? failure : new Error(String(failure)),
          line
        }
      }
    },
    tail() {
      return parser || error ? prefix : segments.join('')
    },
    reset() {
      segments = []
      codeUnits = 0
      hasContent = false
      parser = null
      error = null
      prefix = ''
    }
  }
}
