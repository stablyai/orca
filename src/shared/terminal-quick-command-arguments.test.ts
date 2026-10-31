import { describe, expect, it } from 'vitest'
import {
  applyTerminalQuickCommandArguments,
  parseTerminalQuickCommandArguments
} from './terminal-quick-command-arguments'

describe('terminal quick command arguments', () => {
  it('parses free, select, default and optional arguments once per name', () => {
    expect(
      parseTerminalQuickCommandArguments(
        'deploy {{service}} --env {{env:dev, *stage ,prod}} --tag {{tag=latest}} {{note?}} {{env}}'
      )
    ).toEqual([
      { name: 'service', defaultValue: '', required: true },
      { name: 'env', options: ['dev', 'stage', 'prod'], defaultValue: 'stage', required: true },
      { name: 'tag', defaultValue: 'latest', required: true },
      { name: 'note', defaultValue: '', required: false }
    ])
  })

  it('defaults a select to its first option and lets a later token define a bare name', () => {
    expect(parseTerminalQuickCommandArguments('{{env}} {{env:dev,prod}}')).toEqual([
      { name: 'env', options: ['dev', 'prod'], defaultValue: 'dev', required: true }
    ])
  })

  it('leaves shell variables and Go templates alone', () => {
    const text = `echo \${HOME} && docker inspect -f '{{.State.Status}}' {{json .}}`
    expect(parseTerminalQuickCommandArguments(text)).toEqual([])
    expect(applyTerminalQuickCommandArguments(text, {})).toBe(text)
  })

  it('substitutes every token for a name, including its declaration', () => {
    expect(
      applyTerminalQuickCommandArguments('kubectl --context {{env:dev,prod}} -n {{env}} {{tag?}}', {
        env: 'prod',
        tag: ''
      })
    ).toBe('kubectl --context prod -n prod ')
  })

  it('collapses line breaks in values so a run never submits a partial line', () => {
    expect(applyTerminalQuickCommandArguments('grep {{q}} log', { q: 'a\r\nb' })).toBe(
      'grep a b log'
    )
  })
})
