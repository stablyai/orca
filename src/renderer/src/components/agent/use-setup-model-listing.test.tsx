// @vitest-environment happy-dom
import { useEffect, useState } from 'react'
import { cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import type { AgentPickerEntry } from '../../../../shared/agent-launch/picker/agent-launch-picker'
import { observeAgentPickerAcquisition } from './agent-launch-picker-acquisition'
import { useSetupModelListing } from './use-setup-model-listing'

afterEach(cleanup)

it('delivers a cold DimAgent read when the setup mounts before its acquisition', async () => {
  const key = 'dim-local-workspace'
  const seed: AgentPickerEntry = {
    agent: 'dima',
    label: 'DimAgent',
    rows: [],
    surfaces: ['terminal'],
    defaultSurface: 'terminal',
    terminal: {},
    structured: {},
    catalog: { origin: 'unknown' },
    ownerKey: key
  }
  const model = { id: 'provider/model', label: 'Model', isDefault: false, efforts: [] }
  let observed: AgentPickerEntry = seed

  function Setup({ entry }: { entry: AgentPickerEntry }) {
    useSetupModelListing(entry)
    return null
  }

  function Workspace() {
    const [entry, setEntry] = useState(seed)
    useEffect(
      () =>
        observeAgentPickerAcquisition(
          key,
          [seed],
          {
            catalog: async (_entry, _wait, _signal, relist) =>
              relist ? { origin: 'probe', fetchedAt: 1, models: [model] } : { origin: 'unknown' },
            support: async () => undefined
          },
          {
            publish: ([next]) => {
              observed = next
              setEntry(next)
            },
            selected: () => 'dima'
          }
        ),
      []
    )
    return <Setup entry={entry} />
  }

  render(<Workspace />)
  await waitFor(() => expect(observed.catalog).toMatchObject({ origin: 'probe', models: [model] }))
})
