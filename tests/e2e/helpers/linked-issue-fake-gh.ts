import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export function installLinkedIssueFakeGh(): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'orca-linked-issue-gh-'))
  const source = `
const args = process.argv.slice(2)
const joined = args.join(' ')
if (args.includes('--version')) {
  console.log('gh version 2.63.2')
  process.exit(0)
}
if (args.includes('-X') && !args.includes('GET')) {
  console.error('Read-only fixture refuses writes')
  process.exit(1)
}
if (args[0] === 'auth' && args[1] === 'status') {
  console.error('github.com\\n  ✓ Logged in to github.com account fixture (GITHUB_TOKEN)')
  process.exit(0)
}
if (args[0] === 'api' && args.includes('user')) {
  console.log(JSON.stringify({ login: 'fixture' }))
  process.exit(0)
}
if (args[0] === 'api' && args.includes('rate_limit')) {
  console.log(JSON.stringify({ resources: {
    core: { limit: 5000, remaining: 5000, reset: 0 },
    graphql: { limit: 5000, remaining: 5000, reset: 0 },
    search: { limit: 30, remaining: 30, reset: 0 }
  }}))
  process.exit(0)
}
const issuePath = args.find(arg => /^repos\\/(fork-owner|upstream-owner)\\/widgets\\/issues\\/247$/.test(arg))
if (args[0] === 'api' && issuePath) {
  const owner = issuePath.split('/')[1]
  const fork = owner === 'fork-owner'
  console.log(JSON.stringify({
    number: 247,
    title: fork ? 'Origin hover issue' : 'Upstream hover issue',
    state: fork ? 'open' : 'closed',
    html_url: 'https://github.com/' + owner + '/widgets/issues/247',
    labels: [{ name: fork ? 'fork-label' : 'upstream-label' }],
    body: fork ? 'Fork description' : 'Upstream description'
  }))
  process.exit(0)
}
if (args[0] === 'api' && args.includes('search/issues')) {
  console.log(JSON.stringify({ total_count: 0, incomplete_results: false, items: [] }))
  process.exit(0)
}
if (args[0] === 'api' && args.includes('graphql')) {
  console.log(JSON.stringify({ data: {
    search: { issueCount: 0, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
    repository: { pullRequests: { nodes: [] } }
  }}))
  process.exit(0)
}
if (args[0] === 'pr' && args[1] === 'list') {
  console.log('[]')
  process.exit(0)
}
console.error('Unhandled fixture request: ' + joined)
process.exit(1)
`
  if (process.platform === 'win32') {
    writeFileSync(path.join(directory, 'fake-gh.js'), source)
    writeFileSync(path.join(directory, 'gh.cmd'), '@echo off\r\nnode "%~dp0\\fake-gh.js" %*\r\n')
  } else {
    const executable = path.join(directory, 'gh')
    writeFileSync(executable, `#!/usr/bin/env node\n${source}`)
    chmodSync(executable, 0o755)
  }
  return directory
}
