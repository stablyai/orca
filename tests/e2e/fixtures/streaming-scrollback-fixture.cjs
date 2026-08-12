// Emits numbered scrollback in two stdin-gated phases so tests can interact
// with the terminal between deterministic write batches:
//   phase 1: LINES numbered rows, then STREAM_PHASE1_DONE
//   (waits for any stdin byte — a keypress escape sequence also qualifies)
//   phase 2: LINES more rows in spaced chunks, then STREAM_PHASE2_DONE, exit
const LINES = 300
const PHASE2_CHUNKS = 10
const PHASE2_CHUNK_INTERVAL_MS = 30

let phase = 1

function numberedRows(from, count) {
  let out = ''
  for (let i = from; i < from + count; i += 1) {
    out += `STREAM_LINE_${String(i).padStart(5, '0')}\n`
  }
  return out
}

process.stdout.write(`${numberedRows(0, LINES)}STREAM_PHASE1_DONE\n`)

process.stdin.setEncoding('utf8')
if (process.stdin.isTTY) {
  process.stdin.setRawMode(true)
}
process.stdin.on('data', () => {
  if (phase !== 1) {
    return
  }
  phase = 2
  // Spaced chunks make the renderer process several distinct write batches,
  // which is what re-triggers per-batch scroll-intent enforcement.
  const perChunk = Math.ceil(LINES / PHASE2_CHUNKS)
  let chunk = 0
  const timer = setInterval(() => {
    process.stdout.write(numberedRows(LINES + chunk * perChunk, perChunk))
    chunk += 1
    if (chunk >= PHASE2_CHUNKS) {
      clearInterval(timer)
      process.stdout.write('STREAM_PHASE2_DONE\n')
      process.exit(0)
    }
  }, PHASE2_CHUNK_INTERVAL_MS)
})
