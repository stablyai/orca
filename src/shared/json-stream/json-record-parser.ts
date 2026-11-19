import Assembler from 'stream-json/core/assembler.js'
import { createJsonTokenReader } from './json-token-reader'

/** Assemble a record without flattening all of its text into one V8 string. */
export function createJsonRecordParser(): {
  write: (text: string) => void
  end: () => unknown
} {
  const assembler = new Assembler()
  const reader = createJsonTokenReader((token) => assembler.consume(token))
  return {
    write: reader.write,
    end() {
      reader.end()
      return assembler.current
    }
  }
}

export const LARGE_JSON_RECORD_PARSER = {
  minCodeUnits: 16 * 1024 * 1024,
  create: createJsonRecordParser
}
