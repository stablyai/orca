// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SkillInstallAgentPicker } from './SkillInstallAgentPicker'

describe('SkillInstallAgentPicker', () => {
  afterEach(() => {
    cleanup()
  })

  it('renders summary in trigger button and title tooltip for hover', () => {
    const selected = new Set(['claude', 'cursor'] as const)
    render(
      <SkillInstallAgentPicker
        id="test-agents"
        scope="workspace"
        selected={selected}
        detectedAgents={['claude', 'cursor', 'codex']}
        busy={false}
        onChange={() => undefined}
      />
    )

    const trigger = screen.getByRole('button', { name: /Installing for:/ })
    expect(trigger).toBeTruthy()
    expect(trigger.getAttribute('title')).toContain('Installing for:')
    expect(trigger.textContent).toContain('Claude Code')
    expect(trigger.textContent).toContain('Cursor')
  })

  it('allows toggling selectable agents in popover', () => {
    const onChange = vi.fn()
    const selected = new Set(['claude'] as const)
    render(
      <SkillInstallAgentPicker
        scope="global"
        selected={selected}
        detectedAgents={['claude', 'cursor']}
        busy={false}
        onChange={onChange}
      />
    )

    const trigger = screen.getByRole('button', { name: /Installing for:/ })
    fireEvent.click(trigger)

    expect(screen.getByText('Additional Agent Directories')).toBeTruthy()
    const cursorCheckbox = screen.getByRole('checkbox', { name: 'Cursor' })
    expect(cursorCheckbox).toBeTruthy()
    fireEvent.click(cursorCheckbox)

    expect(onChange).toHaveBeenCalled()
    const [next] = onChange.mock.calls[0] as [Set<string>]
    expect(next.has('cursor')).toBe(true)
  })

  it('selects all selectable agents with header action', () => {
    const onChange = vi.fn()
    const selected = new Set(['claude'] as const)
    render(
      <SkillInstallAgentPicker
        scope="global"
        selected={selected}
        detectedAgents={['claude', 'cursor', 'gemini']}
        busy={false}
        onChange={onChange}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: /Installing for:/ }))

    const selectAllBtn = screen.getByRole('button', { name: 'Select all' })
    fireEvent.click(selectAllBtn)

    expect(onChange).toHaveBeenCalled()
    const [next] = onChange.mock.calls[0] as [Set<string>]
    expect(next.has('cursor')).toBe(true)
    expect(next.has('gemini')).toBe(true)
  })

  it('shows canonical agents in standard agents section with explanation', () => {
    render(
      <SkillInstallAgentPicker
        scope="workspace"
        selected={new Set()}
        detectedAgents={['codex']}
        busy={false}
        onChange={() => undefined}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: /Installing for:/ }))
    expect(screen.getByText('Standard Agents (Always Included)')).toBeTruthy()
    expect(screen.getByText('Codex')).toBeTruthy()
    expect(screen.getByText('Cursor')).toBeTruthy()
    expect(screen.getByText('Gemini CLI')).toBeTruthy()
  })

  it('shows not installed note for detected agents not found', () => {
    render(
      <SkillInstallAgentPicker
        scope="workspace"
        selected={new Set()}
        detectedAgents={[]}
        busy={false}
        onChange={() => undefined}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: /Installing for:/ }))
    expect(screen.getAllByText('Not installed').length).toBeGreaterThan(0)
  })
})
