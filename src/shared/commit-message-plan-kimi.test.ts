import { expect, it } from 'vitest'
import { planCommitMessageGeneration } from './commit-message-plan'
import { KIMI_VALUE_OPTIONS } from './commit-message-generation-options'

function plan(prefix = '', agentArgs = '', prompt = 'P') {
  const result = planCommitMessageGeneration(
    { agentId: 'kimi', model: 'default', agentCommandOverride: `kimi ${prefix}`, agentArgs },
    prompt
  )
  if (!result.ok) {
    throw new Error(result.error)
  }
  return result.plan
}
const base = '--prompt P'
const stream = '--output-format stream-json'
const text = '--output-format text'
const equalsText = '--output-format=text'
it.each([
  ['', `${equalsText} ${stream}`, `${base} ${equalsText}`, false],
  [text, '--output-format=stream-json', `${base} --output-format=stream-json`, true],
  [`${equalsText} ${stream}`, '', `${equalsText} ${base}`, false],
  ['', `${text} -- ${stream}`, `${base} ${text} -- ${stream}`, false],
  [`-- ${stream}`, '', `-- ${stream} ${base} ${stream}`, false],
  [`--model "--" ${text}`, stream, `--model -- ${base} ${stream}`, true],
  [
    '-mprefix --keep before',
    '-mrecipe --model ignored --keep after',
    `--keep before ${base} ${stream} -mrecipe --keep after`,
    true
  ]
])('preserves prefix %s / recipe %s', (prefix, recipe, argv, selected) => {
  const result = plan(prefix, recipe)
  expect(result.args).toEqual(argv.split(' '))
  expect(result.outputFormat).toBe(selected ? 'kimi-stream-json' : undefined)
})
it.each(KIMI_VALUE_OPTIONS.filter((option) => option !== '--output-format'))(
  'preserves required operands of %s including a literal terminator',
  (option) => {
    for (const value of ['--', '--output-format=text']) {
      expect(plan('', `${option} "${value}"`).args.join(' ')).toBe(
        `${base} ${stream} ${option} ${value}`
      )
    }
  }
)
it.each(['--', '--output-format=text', 'stream-json'])(
  'preserves flag-looking prompt %s',
  (prompt) => {
    expect(plan('', '--output-format=text', prompt).args).toEqual([
      '--prompt',
      prompt,
      '--output-format=text'
    ])
  }
)

it('keeps repeated-format planning linear', () => {
  const slice = Array.prototype.slice
  const counts: number[] = []
  for (const n of [20, 200]) {
    const recipe = Array(n).fill('--output-format=text').join(' ')
    let copied = 0
    Array.prototype.slice = function (start, end) {
      const result = slice.call(this, start, end)
      copied += result.length
      return result
    }
    let result
    try {
      result = plan('', recipe)
    } finally {
      Array.prototype.slice = slice
    }
    expect(result.args).toEqual(['--prompt', 'P', '--output-format=text'])
    expect(copied).toBeLessThan(5 * n + 100)
    counts.push(copied)
  }
  expect(counts[1]).toBeLessThanOrEqual(10 * counts[0])
})
