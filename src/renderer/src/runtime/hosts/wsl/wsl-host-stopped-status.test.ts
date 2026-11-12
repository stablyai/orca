import { describe, expect, it } from 'vitest'
import type { WslHostConnectionState } from '../../../../../shared/wsl-host-types'
import { selectConnectingWslDistro, selectStoppedWslDistro } from './wsl-host-stopped-status'

const stateWith = (state: WslHostConnectionState) => ({
  wslHostStatuses: { env: { environmentId: 'env', distro: 'demo', state, detail: null } }
})

describe('selectConnectingWslDistro', () => {
  it.each<[WslHostConnectionState, string | null]>([
    ['connecting', 'demo'],
    ['reconnecting', 'demo'],
    ['ready', null],
    ['distro-stopped', null],
    ['failed', null]
  ])('%s', (state, expected) => {
    expect(selectConnectingWslDistro(stateWith(state), 'env')).toBe(expected)
  })

  it('is null for an unknown host and never overlaps stopped', () => {
    expect(selectConnectingWslDistro(stateWith('connecting'), 'other')).toBeNull()
    expect(selectConnectingWslDistro(stateWith('connecting'), null)).toBeNull()
    expect(selectStoppedWslDistro(stateWith('connecting'), 'env')).toBeNull()
  })
})
