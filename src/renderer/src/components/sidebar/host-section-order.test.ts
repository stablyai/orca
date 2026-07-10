import { describe, expect, it } from 'vitest'
import { orderHostSectionOptions } from './host-section-order'
import type { HostSectionOption } from './host-section-rows'

const host = (id: HostSectionOption['id'], label = id): HostSectionOption => ({
  id,
  kind: id === 'local' ? 'local' : id.startsWith('ssh:') ? 'ssh' : 'runtime',
  label,
  detail: 'Host',
  health: id === 'local' ? 'local' : 'available'
})

describe('orderHostSectionOptions', () => {
  it('applies persisted host order and appends newly discovered hosts', () => {
    expect(
      orderHostSectionOptions(
        [host('local'), host('ssh:ssh-1'), host('runtime:env-1')],
        ['ssh:ssh-1', 'local']
      ).map((option) => option.id)
    ).toEqual(['ssh:ssh-1', 'local', 'runtime:env-1'])
  })

  it('ignores stale host ids in the persisted order', () => {
    expect(
      orderHostSectionOptions(
        [host('local'), host('ssh:ssh-1')],
        ['runtime:deleted', 'ssh:ssh-1']
      ).map((option) => option.id)
    ).toEqual(['ssh:ssh-1', 'local'])
  })
})
