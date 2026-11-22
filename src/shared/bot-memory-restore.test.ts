import { describe, expect, it } from 'vitest'
import { botMemoryChange, dropBotMemoryFact, type BotMemoryLine } from './bot-memory-lines'
import { mergeBotMemoryCopies, restoreBotMemoryLines } from './bot-memory-restore'

// Wall time on a loaded machine can't tell one pass from a scan per copy; element reads can.
function counted<T>(items: T[]): { array: T[]; reads: () => number } {
  let reads = 0
  const array = new Proxy(items, {
    get(target, key, receiver) {
      if (typeof key === 'string' && /^\d+$/.test(key)) {
        reads += 1
      }
      return Reflect.get(target, key, receiver)
    }
  })
  return { array, reads: () => reads }
}

const COUNT = 2_000
const COPY = '- sep is a  b'
const headings = Array.from({ length: COUNT }, (_, index) => `# ${index}`)
const file = `${headings.flatMap((heading) => [heading, COPY]).join('\n')}\n`
const lines = (text: string): string[] => text.split('\n')
const forget = (text: string): BotMemoryLine[] =>
  botMemoryChange(text, dropBotMemoryFact(text, 'sep is a  b').text, {
    keepRemovedPositions: true
  }).removed
// A handful of reads per line and copy: work that grows with lines times copies fails this.
const linear = (...sizes: number[]): number => 8 * sizes.reduce((sum, size) => sum + size, 0)

describe('putting back many copies of one fact into a long file', () => {
  it('reads each line and copy a bounded number of times', () => {
    const kept = counted(lines(dropBotMemoryFact(file, 'sep is a  b').text))
    const copies = counted(forget(file))
    expect(copies.array).toHaveLength(COUNT)

    expect(restoreBotMemoryLines(kept.array, copies.array).join('\n')).toBe(file)
    expect(kept.reads() + copies.reads()).toBeLessThan(linear(2 * COUNT, COUNT))
  })

  it('merges the copies the file and the record lost in one pass, in their places', () => {
    const disk = `${headings.flatMap((heading, index) => (index % 2 ? [heading, COPY] : [heading])).join('\n')}\n`
    const onDisk = counted(forget(disk))
    const inRecord = counted(forget(file))
    const merged = mergeBotMemoryCopies(onDisk.array, inRecord.array, true)
    expect(merged).toHaveLength(COUNT)
    expect(onDisk.reads() + inRecord.reads()).toBeLessThan(linear(COUNT / 2, COUNT))

    const kept = counted(lines(dropBotMemoryFact(disk, 'sep is a  b').text))
    expect(restoreBotMemoryLines(kept.array, merged).join('\n')).toBe(file)
    expect(kept.reads()).toBeLessThan(linear(2 * COUNT, COUNT))
  })

  it('puts back many distinct lost facts after their own lines in one pass', () => {
    const distinct = `${headings.flatMap((heading, index) => [heading, `- fact ${index}`]).join('\n')}\n`
    const bare = `${headings.join('\n')}\n`
    const kept = counted(lines(bare))
    const lost = counted(botMemoryChange(distinct, bare).removed)

    expect(restoreBotMemoryLines(kept.array, lost.array).join('\n')).toBe(distinct)
    expect(kept.reads() + lost.reads()).toBeLessThan(linear(COUNT, COUNT))
  })
})
