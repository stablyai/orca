// @vitest-environment happy-dom

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { GlobalSettings } from '../../../../shared/types'
import { useAppStore } from '../../store'
import { AgentSessionRulesPane } from './AgentSessionRulesPane'

describe('AgentSessionRulesPane', () => {
  it('retains an edited rule draft when persistence rejects the save', async () => {
    const settings = {
      agentSessionRules: {
        enabled: true,
        rules: [
          {
            id: 'custom-rule',
            label: 'Custom rule',
            content: 'original text',
            enabled: true,
            source: 'custom'
          }
        ],
        seenBuiltinRuleIds: ['builtin-graphify']
      }
    } as unknown as GlobalSettings
    useAppStore.setState({ settings })
    const updateSettings = vi.fn().mockRejectedValue(new Error('disk full'))

    render(<AgentSessionRulesPane settings={settings} updateSettings={updateSettings} />)
    fireEvent.change(screen.getByDisplayValue('original text'), {
      target: { value: 'unsaved text' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(updateSettings).toHaveBeenCalledOnce())
    expect(screen.getByDisplayValue('unsaved text')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Save' })).toBeTruthy()
  })

  it('retains an edited rule draft when delete persistence fails', async () => {
    const settings = {
      agentSessionRules: {
        enabled: true,
        rules: [
          {
            id: 'custom-rule',
            label: 'Custom rule',
            content: 'original text',
            enabled: true,
            source: 'custom'
          }
        ],
        seenBuiltinRuleIds: ['builtin-graphify']
      }
    } as unknown as GlobalSettings
    useAppStore.setState({ settings })
    const updateSettings = vi.fn().mockRejectedValue(new Error('disk full'))

    const view = render(
      <AgentSessionRulesPane settings={settings} updateSettings={updateSettings} />
    )
    fireEvent.change(view.getByDisplayValue('original text'), {
      target: { value: 'unsaved text' }
    })
    fireEvent.click(view.container.querySelector('[aria-label="Delete rule"]')!)

    await waitFor(() => expect(updateSettings).toHaveBeenCalledOnce())
    expect(view.container.querySelector('textarea')?.value).toBe('unsaved text')
  })
})
