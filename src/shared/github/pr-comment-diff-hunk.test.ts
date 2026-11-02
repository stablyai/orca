import { describe, expect, it } from 'vitest'
import { tailDiffHunk, threadDiffLines } from './pr-comment-diff-hunk'

const HUNK = [
  '@@ -20,4 +20,6 @@ export function Banner(props) {',
  '   return (',
  '-    <View style={styles.box}>',
  '+    <View style={styles.banner}>',
  '+      <Icon size={16} radius={20} />',
  '       <Text>{props.title}</Text>'
].join('\n')

describe('pr comment diff hunk', () => {
  it('drops the header and keeps the tail the host forwards', () => {
    expect(tailDiffHunk(HUNK)?.startsWith('   return (')).toBe(true)
    expect(tailDiffHunk('')).toBeUndefined()
  })

  it('numbers the anchored lines back from the end line, skipping removed lines', () => {
    const tail = tailDiffHunk(HUNK) ?? ''
    const strip = (lines: ReturnType<typeof threadDiffLines>) =>
      lines.map(({ number, sign, text }) => ({ number, sign, text }))
    expect(strip(threadDiffLines(tail, 23))).toEqual([
      { number: 23, sign: ' ', text: '      <Text>{props.title}</Text>' }
    ])
    // A hunk ending on line 21 with a removal inside 20..21: it shows unnumbered and line 20 still shows.
    const toLine21 = tail.split('\n').slice(0, 3).join('\n')
    expect(strip(threadDiffLines(toLine21, 21, 20))).toEqual([
      { number: 20, sign: ' ', text: '  return (' },
      { number: null, sign: '-', text: '    <View style={styles.box}>' },
      { number: 21, sign: '+', text: '    <View style={styles.banner}>' }
    ])
  })
})
