import { describe, expect, it } from 'vitest'
import { botLineLanes, lanesNeedingYouFirst } from './bot-line-lanes'

describe('botLineLanes', () => {
  it('lists every descendant once at one level, those waiting on the owner first', () => {
    const children: Record<string, string[]> = {
      run: ['prose', 'tests', 'proxy'],
      prose: ['qa-pr', 'run'],
      proxy: ['tests']
    }
    const lanes = botLineLanes(
      'run',
      (line) => children[line] ?? [],
      (line) => line
    )
    expect(lanes).toEqual(['prose', 'qa-pr', 'tests', 'proxy'])
    expect(lanesNeedingYouFirst(lanes, (line) => line === 'qa-pr' || line === 'proxy')).toEqual([
      'qa-pr',
      'proxy',
      'prose',
      'tests'
    ])
  })
})
