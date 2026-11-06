import { expect, it } from 'vitest'
import { OMP_SESSION_OPTION_CATALOG as seed } from './agent-session-option-catalog-omp'
import {
  applyStructuredAgentSessionModelCatalog,
  applyStructuredAgentSessionOptions,
  createStructuredAgentSessionOptionState
} from './structured-agent-session-options'
import {
  structuredAgentSessionOptionView,
  structuredAgentSessionShownSnapshot
} from './structured-agent-session-option-view'

it('replaces an unconfirmed OMP menu and retains discovery across another model’s live answer', () => {
  const row = {
    id: 'provider/target',
    label: 'Target',
    isDefault: false,
    effortsKnown: false as const,
    efforts: ['low', 'medium', 'max'].map((value) => ({ value, label: value }))
  }
  const catalog = (model: typeof row | Omit<typeof row, 'effortsKnown'>) => ({
    origin: 'probe' as const,
    fetchedAt: 1,
    models: [model]
  })
  const view = (state: ReturnType<typeof createStructuredAgentSessionOptionState>) =>
    structuredAgentSessionShownSnapshot(
      structuredAgentSessionOptionView(state, undefined, { model: row.id })
    ).find((option) => option.id === 'effort')
  const initial = applyStructuredAgentSessionModelCatalog(
    createStructuredAgentSessionOptionState('omp', seed),
    seed,
    catalog(row),
    { newLaunch: true }
  )
  expect(view(initial)).toBeUndefined()
  const { effortsKnown: _unknown, ...known } = row
  const discovered = applyStructuredAgentSessionModelCatalog(
    initial,
    seed,
    catalog({
      ...known,
      efforts: ['off', 'auto', 'low', 'medium', 'high', 'xhigh', 'max'].map((value) => ({
        value,
        label: value
      }))
    }),
    { newLaunch: true }
  )
  const live = applyStructuredAgentSessionOptions(discovered, seed, {
    models: [row],
    current: { model: 'provider/other' }
  })
  expect(view(live)?.kind).toMatchObject({
    choices: [
      { value: 'off' },
      { value: 'auto' },
      { value: 'low' },
      { value: 'medium' },
      { value: 'high' },
      { value: 'xhigh' },
      { value: 'max' }
    ]
  })
})
