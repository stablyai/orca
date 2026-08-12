// @vitest-environment happy-dom

import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { GlobalSettings, Repo } from '../../../../shared/types'
import { useAppStore } from '../../store'
import { RepositoryAgentSessionRulesSection } from './RepositoryAgentSessionRulesSection'
import { useRepositoryAgentSessionRulesWriter } from './repository-agent-session-rules-writer'

describe('useRepositoryAgentSessionRulesWriter', () => {
  it('preserves rapid functional patches while writes are serialized', async () => {
    const updateRepo = vi.fn().mockResolvedValue(true)
    const repo = { id: 'repo-1', agentSessionRules: null } as unknown as Repo
    const { result } = renderHook(() => useRepositoryAgentSessionRulesWriter({ repo, updateRepo }))

    act(() => {
      result.current((current) => ({
        disabledRuleIds: [...(current.disabledRuleIds ?? []), 'rule-a']
      }))
      result.current((current) => ({
        disabledRuleIds: [...(current.disabledRuleIds ?? []), 'rule-b']
      }))
    })

    await waitFor(() => expect(updateRepo).toHaveBeenCalledTimes(2))
    expect(updateRepo.mock.calls[1]?.[1]).toEqual({
      agentSessionRules: { disabledRuleIds: ['rule-a', 'rule-b'] }
    })
  })

  it('reports a rejected repository update so the caller can retain its draft', async () => {
    const updateRepo = vi.fn().mockResolvedValue(false)
    const repo = { id: 'repo-1', agentSessionRules: null } as unknown as Repo
    const { result } = renderHook(() => useRepositoryAgentSessionRulesWriter({ repo, updateRepo }))

    let saved: boolean | undefined
    await act(async () => {
      saved = await result.current({ enabled: false })
    })

    expect(saved).toBe(false)
  })

  it('resets optimistic state after the latest repository update is rejected', async () => {
    const updateRepo = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    const repo = { id: 'repo-1', agentSessionRules: null } as unknown as Repo
    const { result } = renderHook(() => useRepositoryAgentSessionRulesWriter({ repo, updateRepo }))

    await act(async () => {
      await result.current({ disabledRuleIds: ['rule-a'] })
      await result.current((current) => ({
        disabledRuleIds: [...(current.disabledRuleIds ?? []), 'rule-b']
      }))
    })

    expect(updateRepo.mock.calls[1]?.[1]).toEqual({
      agentSessionRules: { disabledRuleIds: ['rule-b'] }
    })
  })

  it('retains an edited repository rule draft when persistence rejects the save', async () => {
    useAppStore.setState({ settings: {} as GlobalSettings })
    const repo = {
      id: 'repo-1',
      agentSessionRules: {
        extraRules: [
          {
            id: 'repo-rule',
            label: 'Repo rule',
            content: 'original text',
            enabled: true,
            source: 'custom'
          }
        ]
      }
    } as unknown as Repo
    const updateRepo = vi.fn().mockResolvedValue(false)

    render(<RepositoryAgentSessionRulesSection repo={repo} updateRepo={updateRepo} />)
    fireEvent.change(screen.getByDisplayValue('original text'), {
      target: { value: 'unsaved text' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(updateRepo).toHaveBeenCalledOnce())
    expect(screen.getByDisplayValue('unsaved text')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Save' })).toBeTruthy()
  })

  it('retains an edited repository rule draft when delete persistence fails', async () => {
    useAppStore.setState({ settings: {} as GlobalSettings })
    const repo = {
      id: 'repo-1',
      agentSessionRules: {
        extraRules: [
          {
            id: 'repo-rule',
            label: 'Repo rule',
            content: 'original text',
            enabled: true,
            source: 'custom'
          }
        ]
      }
    } as unknown as Repo
    const updateRepo = vi.fn().mockResolvedValue(false)

    const view = render(<RepositoryAgentSessionRulesSection repo={repo} updateRepo={updateRepo} />)
    fireEvent.change(view.getByDisplayValue('original text'), {
      target: { value: 'unsaved text' }
    })
    fireEvent.click(view.container.querySelector('[aria-label="Delete rule"]')!)

    await waitFor(() => expect(updateRepo).toHaveBeenCalledOnce())
    expect(view.container.querySelector('textarea')?.value).toBe('unsaved text')
  })
})
