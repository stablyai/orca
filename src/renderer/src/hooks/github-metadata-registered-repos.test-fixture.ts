import type { Repo } from '../../../shared/repo-types'

function row(host: 'local' | `runtime:${string}`, user: string): Repo {
  return {
    id: 'shared',
    path: '/shared',
    executionHostId: host,
    displayName: 'shared',
    badgeColor: '',
    addedAt: 0,
    ghAccount: { host: 'github.corp', user },
    issueSourcePreference: host === 'local' ? 'upstream' : 'origin'
  }
}
export const ROW_COUNT = 250
export function registeredRows() {
  return [
    row('local', 'L'),
    row('runtime:S', 'A'),
    row('runtime:unused', 'unused'),
    ...Array.from({ length: ROW_COUNT - 3 }, (_, index) => ({
      ...row('runtime:unused', 'unused'),
      id: `other-${index}`,
      path: `/other-${index}`
    }))
  ]
}
