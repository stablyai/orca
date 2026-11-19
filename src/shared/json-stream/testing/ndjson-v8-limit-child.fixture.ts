import { constants } from 'node:buffer'
import { createIncrementalNdjsonFramer } from '../main-process-ndjson-framer'
import { LARGE_JSON_RECORD_PARSER } from '../json-record-parser'

const records: unknown[] = []
const rejected: string[] = []
let paused = false
const reader = createIncrementalNdjsonFramer(
  (record) => {
    records.push(record)
    paused = records.length === 1
  },
  (rejection) => {
    rejected.push(rejection.kind)
  },
  {
    maxLineBytes: Infinity,
    shouldPause: () => paused,
    largeRecordParser: LARGE_JSON_RECORD_PARSER
  }
)

reader.feed(
  '{"id":7,"result":{"thread":{"id":"legacy","__proto__":{"safe":true},"turns":[{"id":"turn-1","items":[{"type":"imageGeneration","id":"image-1","result":"YQ=="}]}]}}'
)
// Reuse one padding chunk to exceed V8's limit without allocating a giant test fixture.
const padding = ' '.repeat(64 * 1024)
for (let size = 0; size <= constants.MAX_STRING_LENGTH; size += padding.length) {
  reader.feed(padding)
}
reader.feed('}\n{"id":8,"result":{"data":[],"nextCursor":null}}\n')
paused = false
reader.resume()
reader.feed('{"bad":[')
for (let size = 0; size <= 16 * 1024 * 1024; size += padding.length) {
  reader.feed(padding)
}
reader.feed('!}\n{"id":9,"result":"still connected"}\n')
console.log(JSON.stringify({ records, rejected }))
