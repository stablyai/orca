import { createRequire } from 'node:module'
import type * as HistoryFilesystem from '../../native/history-filesystem'

const [binary, source, destination, name] = process.argv.slice(2)
// SAFETY: the parent test supplies its actually built target binary, not a fixture implementation.
const binding: typeof HistoryFilesystem = createRequire(__filename)(binary)
const from = binding.openDirectory(source, false)
const to = binding.openDirectory(destination, false)
process.stdout.write(`ready:${process.pid}\n`)
process.stdin.once('data', () => {
  try {
    process.stdout.write(`${from.move(name, to, name)}\n`)
  } finally {
    from.close()
    to.close()
    process.stdin.destroy()
  }
})
