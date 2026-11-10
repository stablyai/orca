import { expect, it } from 'vitest'
import { getTranslatedExecutionHostLabel, translateHostDisplayLabel } from './execution-host-label'
import type { Translate } from '@/i18n/use-translate'

const t: Translate = () => 'generated label'

it('preserves configured names and translates generated local labels', () => {
  expect(translateHostDisplayLabel({ label: 'Local Mac' }, t)).toBe('Local Mac')
  expect(translateHostDisplayLabel({ label: 'Local Mac', isDefaultLocalLabel: true }, t)).toBe(
    'generated label'
  )
  expect(getTranslatedExecutionHostLabel('ssh:Local%20Mac', t)).toBe('Local Mac')
})
