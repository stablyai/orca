import { expect, it } from 'vitest'
import {
  parseGitHubIssueReference,
  parseIssueRepository,
  resolveGitHubIssueReference
} from './github-issue-reference'

it('resolves shorthand to the named issue on the workspace host', () => {
  const reference = parseGitHubIssueReference(' jdoe_acme/Plan_v2.1#42 ')
  expect(resolveGitHubIssueReference(reference, {})).toEqual({
    kind: 'url',
    owner: 'jdoe_acme',
    repo: 'Plan_v2.1',
    host: 'github.com',
    number: 42,
    url: 'https://github.com/jdoe_acme/Plan_v2.1/issues/42'
  })
  expect(
    resolveGitHubIssueReference(reference, {
      host: 'github.acme.example:8443',
      defaultIssueRepository: { owner: 'Acme-Tools', repo: 'Elsewhere' }
    })
  ).toEqual({
    kind: 'url',
    owner: 'jdoe_acme',
    repo: 'Plan_v2.1',
    host: 'github.acme.example:8443',
    number: 42,
    url: 'https://github.acme.example:8443/jdoe_acme/Plan_v2.1/issues/42'
  })
})

it('only resolves a bare issue number to a URL when there is a default issue repository', () => {
  expect(resolveGitHubIssueReference(parseGitHubIssueReference('42'), {})).toEqual({
    kind: 'bare',
    number: 42
  })
  expect(resolveGitHubIssueReference(parseGitHubIssueReference('#42'), {})).toEqual({
    kind: 'bare',
    number: 42
  })
  expect(
    resolveGitHubIssueReference(parseGitHubIssueReference('#42'), {
      host: 'github.acme.example',
      defaultIssueRepository: parseIssueRepository(' jdoe_acme/Planning ')
    })
  ).toEqual({
    kind: 'url',
    owner: 'jdoe_acme',
    repo: 'Planning',
    host: 'github.acme.example',
    number: 42,
    url: 'https://github.acme.example/jdoe_acme/Planning/issues/42'
  })
})

it('keeps the repository and comment anchor of a pasted issue URL', () => {
  expect(
    resolveGitHubIssueReference(
      parseGitHubIssueReference(
        'https://github.example:8443/jdoe_acme/Planning/issues/42#issuecomment-3'
      ),
      { host: 'github.com', defaultIssueRepository: { owner: 'Acme', repo: 'Elsewhere' } }
    )
  ).toEqual({
    kind: 'url',
    owner: 'jdoe_acme',
    repo: 'Planning',
    host: 'github.example:8443',
    number: 42,
    url: 'https://github.example:8443/jdoe_acme/Planning/issues/42#issuecomment-3'
  })
})

it('rejects invalid issue numbers, malformed repositories, and embedded reference fragments', () => {
  const inputs = [
    '0',
    '#9007199254740992',
    'acme/planning#0',
    'acme/planning#abc',
    '-acme/planning#42',
    '_acme/planning#42',
    'acme/../#42',
    'acme/..#42',
    'acme/bad repo#42',
    'https://github.com/acme/planning#42',
    'https://github.com/acme/bad%2Frepo/issues/42',
    'https://github.com/acme/planning/pull/42'
  ]
  expect(inputs.map(parseGitHubIssueReference)).toEqual(Array(12).fill(null))
})
