import { getPiCompatibleTitleSeparatorStatus } from './pi-compatible-synthetic-title'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { detectAgentStatusFromTitle, getAgentLabel } from './agent-detection'
import { normalizeCompatibleAgentTitleForOwner } from './agent-title-owner'
import { clearPiStateWorkingMarker } from './pi-state-title-marker'

const transcript = readFileSync(
  join(__dirname, '..', 'main', 'runtime', '__fixtures__', 'omp-native-title-win32.txt'),
  'utf8'
)
// oxlint-disable-next-line no-control-regex -- The fixture retains actual OSC control bytes.
const titles = [...transcript.matchAll(/\x1b\]0;([^\x07]+)\x07/g)].map((match) => match[1])

describe('owner-rewritten OMP titles from captured upstream output', () => {
  it('contains the six upstream state frames', () => expect(titles).toHaveLength(6))
  it.each(
    titles.map((title, index) => ({
      title,
      state: index < 2 ? 'working' : index < 4 ? 'idle' : 'permission'
    }))
  )('preserves $state and label for $title', ({ title, state }) => {
    for (const prefix of ['', 'zsh | ', 'tmux: ']) {
      const wrapped = prefix + title
      expect(detectAgentStatusFromTitle(wrapped)).toBe(state)
      const owned = normalizeCompatibleAgentTitleForOwner(wrapped, 'omp', { ownerIsLaunch: true })
      expect(owned).toBe(prefix + title.replace('π', 'OMP'))
      expect(getAgentLabel(owned)).toBe('OMP')
      expect(detectAgentStatusFromTitle(owned)).toBe(state)
      expect(getPiCompatibleTitleSeparatorStatus(owned)).toBe(state)
      expect(normalizeCompatibleAgentTitleForOwner(owned, 'omp')).toBe(owned)
      expect(normalizeCompatibleAgentTitleForOwner(owned, 'pi')).toBe(
        prefix + title.replace('π', 'Pi')
      )
      if (state === 'working') {
        expect(detectAgentStatusFromTitle(clearPiStateWorkingMarker(owned) ?? '')).toBe('idle')
      }
    }
  })
  it.each([
    'omp-harness ready',
    '/tmp/OMP : file',
    'lowercase omp : note',
    'Pi: legacy',
    'OMP ready'
  ])('does not rewrite neutral or legacy title %s as a working marker', (title) => {
    expect(clearPiStateWorkingMarker(title)).toBeNull()
    expect(detectAgentStatusFromTitle(title)).not.toBe('working')
  })
})
