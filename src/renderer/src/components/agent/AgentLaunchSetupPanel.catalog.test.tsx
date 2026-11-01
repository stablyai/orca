// @vitest-environment happy-dom
import {
  AgentLaunchSetupPanel,
  entry,
  host,
  root,
  onUse
} from './agent-launch-setup-panel-test-fixture'
import { act } from 'react'
import { fireEvent } from '@testing-library/react'
import { expect, it } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { AgentPickerEntry } from '../../../../shared/agent-launch-picker'

it.each([
  [undefined, { origin: 'unknown' }, 'Pi models are unavailable on this host.', false],
  [undefined, { origin: 'probe', fetchedAt: 1, models: [] }, 'Pi has no available models.', false],
  ['pending', { origin: 'unknown' }, null, true],
  ['failed', { origin: 'unknown' }, 'Could not load Pi models.', false],
  ['unsupported', { origin: 'unknown' }, 'Pi models are unavailable on this host.', false],
  ['settled', { origin: 'unknown' }, 'Pi models have not loaded.', false],
  ['settled', { origin: 'unknown', listingInProgress: true }, 'Pi models have not loaded.', false],
  [
    'settled',
    { origin: 'unknown', unavailable: { reason: 'notSignedIn' } },
    'Sign in to Pi',
    false
  ],
  ['settled', { origin: 'unknown', unavailable: { reason: 'cliMissing' } }, 'Install Pi', false],
  ['settled', { origin: 'probe', fetchedAt: 1, models: [] }, 'Pi has no available models.', false]
] satisfies [
  AgentPickerEntry['catalogRead'],
  AgentPickerEntry['catalog'],
  string | null,
  boolean
][])(
  'distinguishes catalog %s/%j without gating the literal action',
  (catalogRead, catalog, message, busy) => {
    act(() =>
      root.render(
        <TooltipProvider>
          <AgentLaunchSetupPanel
            entry={{
              ...entry,
              agent: 'pi',
              label: 'Pi',
              catalogRead,
              catalog,
              terminal: { permissionMode: 'ask' },
              arguments: '--debug',
              defaultSurface: 'terminal'
            }}
            initial={{
              agent: 'pi',
              surface: 'terminal',
              arguments: '--debug',
              choices: { permissionMode: 'ask' }
            }}
            onUse={onUse}
          />
        </TooltipProvider>
      )
    )
    const input = host.querySelector<HTMLInputElement>('input[aria-label="Search models"]')!
    expect(input.getAttribute('aria-busy')).toBe(String(busy))
    expect(input.disabled).toBe(busy)
    expect(host.textContent).not.toContain('No models match your search.')
    if (message) {
      expect(host.querySelector('[role="status"]')?.textContent).toContain(message)
    } else {
      expect(host.querySelector('[role="status"]')).toBeNull()
    }
    const launch = [...host.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Launch terminal')
    )!
    expect(launch.disabled).toBe(false)
    fireEvent.click(launch)
    expect(onUse).toHaveBeenCalledOnce()
    expect(onUse.mock.calls[0][0]).toMatchObject({
      arguments: '--debug',
      choices: { permissionMode: 'ask' }
    })
  }
)

it('keeps known seed choices usable after catalog failure and preserves an opaque draft across publication', async () => {
  const failed: AgentPickerEntry = { ...entry, arguments: '', catalogRead: 'failed' }
  const draw = (value: AgentPickerEntry) =>
    act(() =>
      root.render(
        <TooltipProvider>
          <AgentLaunchSetupPanel
            entry={value}
            initial={{
              agent: 'claude',
              surface: 'terminal',
              choices: { model: 'retired-model', permissionMode: 'ask' },
              arguments: '--debug'
            }}
            onUse={onUse}
          />
        </TooltipProvider>
      )
    )
  draw(failed)
  expect(host.querySelector<HTMLInputElement>('input[aria-label="Search models"]')!.disabled).toBe(
    false
  )
  expect(host.textContent).toContain('retired-model')
  expect(host.querySelector('[role="status"]')).toBeNull()
  draw({
    ...failed,
    catalogRead: 'settled',
    catalog: {
      origin: 'probe',
      fetchedAt: 1,
      models: [{ id: 'new-model', label: 'New model', isDefault: true, efforts: [] }]
    }
  })
  fireEvent.click(
    [...host.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Launch terminal')
    )!
  )
  expect(onUse.mock.calls[0][0]).toMatchObject({
    choices: { model: 'retired-model' },
    arguments: '--debug'
  })
})

it('renders localized unresolved guidance from the real Spanish catalog', async () => {
  const { i18n, loadRendererUiLanguage } = await import('@/i18n/i18n')
  const language = i18n.language
  try {
    await loadRendererUiLanguage('es')
    await i18n.changeLanguage('es')
    act(() =>
      root.render(
        <TooltipProvider>
          <AgentLaunchSetupPanel
            entry={{ ...entry, agent: 'pi', label: 'Pi', catalogRead: 'settled' }}
            onUse={onUse}
          />
        </TooltipProvider>
      )
    )
    expect(host.querySelector('[role="status"]')?.textContent).toBe(
      'Los modelos de Pi no se han cargado. Cierra y vuelve a abrir el selector de agentes para intentarlo de nuevo.'
    )
    expect(host.textContent).not.toContain('No models match your search.')
  } finally {
    await i18n.changeLanguage(language)
  }
})

it.each([
  ['unsupported', { origin: 'unknown' }],
  ['settled', { origin: 'unknown', listingInProgress: true }],
  ['settled', { origin: 'unknown', unavailable: { reason: 'notSignedIn' } }],
  ['settled', { origin: 'unknown', unavailable: { reason: 'cliMissing' } }]
] satisfies [AgentPickerEntry['catalogRead'], AgentPickerEntry['catalog']][])(
  'shows usable seeded rows instead of %s/%j guidance',
  (catalogRead, catalog) => {
    act(() =>
      root.render(
        <TooltipProvider>
          <AgentLaunchSetupPanel entry={{ ...entry, catalogRead, catalog }} onUse={onUse} />
        </TooltipProvider>
      )
    )
    expect(host.querySelector('[role="status"]')).toBeNull()
    expect(host.querySelector('input[aria-label="Search models"]')).toHaveProperty(
      'disabled',
      false
    )
    expect(host.querySelector('[cmdk-item]:not([data-disabled="true"])')).not.toBeNull()
  }
)

it('keeps the actual retained current row usable during an owned read without inventing a catalog model', () => {
  act(() =>
    root.render(
      <TooltipProvider>
        <AgentLaunchSetupPanel
          entry={{
            ...entry,
            catalogRead: 'pending',
            catalog: { origin: 'probe', fetchedAt: 1, models: [] }
          }}
          initial={{
            agent: 'claude',
            surface: 'terminal',
            choices: { model: 'retained-team-model' },
            arguments: '--debug'
          }}
          onUse={onUse}
        />
      </TooltipProvider>
    )
  )
  expect(host.querySelector('[role="status"]')).toBeNull()
  expect(host.querySelector('input[aria-label="Search models"]')?.getAttribute('aria-busy')).toBe(
    'false'
  )
  const row = host.querySelector('[cmdk-item][data-current="true"]')!
  expect(row.textContent).toBe('retained-team-model')
  expect(row.getAttribute('data-disabled')).not.toBe('true')
  fireEvent.click(row)
  fireEvent.click(
    [...host.querySelectorAll('button')].find((button) => button.textContent === 'Launch terminal')!
  )
  expect(onUse).toHaveBeenCalledOnce()
  expect(onUse.mock.calls[0][0]).toMatchObject({
    choices: { model: 'retained-team-model' },
    arguments: '--debug'
  })
})

it('keeps failed guidance when opaque Arguments supply no real current model row', () => {
  const args = '--settings ./team.json --debug'
  act(() =>
    root.render(
      <TooltipProvider>
        <AgentLaunchSetupPanel
          entry={{
            ...entry,
            terminal: { permissionMode: 'ask' },
            catalogRead: 'failed',
            catalog: { origin: 'probe', fetchedAt: 1, models: [] }
          }}
          initial={{ agent: 'claude', surface: 'terminal', choices: {}, arguments: args }}
          onUse={onUse}
        />
      </TooltipProvider>
    )
  )
  expect(host.querySelector('[role="status"]')?.textContent).toContain(
    'Could not load Claude models.'
  )
  expect(host.querySelector('[cmdk-item][data-current="true"]')).toBeNull()
  expect(host.textContent).not.toContain('No models match your search.')
  fireEvent.click(
    [...host.querySelectorAll('button')].find((button) => button.textContent === 'Launch terminal')!
  )
  expect(onUse).toHaveBeenCalledOnce()
  expect(onUse.mock.calls[0][0]).toMatchObject({ choices: {}, arguments: args })
})
