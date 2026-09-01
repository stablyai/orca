// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentLaunchNoticeList } from './AgentLaunchNotices'
import type {
  AgentLaunchNotice,
  AgentLaunchNoticeCode
} from '../../../../shared/agent-launch-contract'

const mountedRoots: Root[] = []

async function renderList(
  notices: AgentLaunchNotice[],
  onDismiss: (code: AgentLaunchNoticeCode) => void
): Promise<void> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  mountedRoots.push(root)
  await act(async () => {
    root.render(<AgentLaunchNoticeList notices={notices} onDismiss={onDismiss} />)
  })
}

afterEach(() => {
  for (const root of mountedRoots.splice(0)) {
    act(() => root.unmount())
  }
  document.body.innerHTML = ''
})

describe('AgentLaunchNoticeList', () => {
  it('renders honest per-code copy for the fallback and env banner tiers', async () => {
    await renderList(
      [
        { code: 'disabled_custom_fallback', label: 'My Claude', baseAgent: 'claude' },
        { code: 'missing_custom_fallback', label: 'Old Codex', baseAgent: 'codex' },
        { code: 'env_withheld', label: 'My Claude' },
        { code: 'vault_original_config_unavailable', baseAgent: 'codex' }
      ],
      vi.fn()
    )
    const text = document.body.textContent ?? ''
    expect(text).toContain(
      'My Claude is disabled. Started stock Claude with no custom executable, custom arguments, or custom agent environment.'
    )
    expect(text).toContain(
      'Old Codex was deleted. Started stock Codex with no custom executable, custom arguments, or custom agent environment.'
    )
    expect(text).toContain("This launch did not use all of My Claude's environment values.")
    expect(text).toContain(
      "Original launch settings weren't available. Resumed with current Codex settings."
    )
  })

  it('renders the snapshot notice as a quiet chip, not the banner tier', async () => {
    await renderList([{ code: 'snapshot_definition_changed', label: 'My Claude' }], vi.fn())
    expect(document.body.textContent).toContain(
      'Resumed with the settings captured when this session started.'
    )
  })

  it('reports the exact code to onDismiss when its dismiss button is clicked', async () => {
    const onDismiss = vi.fn()
    await renderList(
      [
        { code: 'disabled_custom_fallback', label: 'My Claude', baseAgent: 'claude' },
        { code: 'env_withheld', label: 'My Claude' }
      ],
      onDismiss
    )
    const dismissButtons = [...document.body.querySelectorAll<HTMLButtonElement>('button')]
    expect(dismissButtons).toHaveLength(2)
    act(() => dismissButtons[0].click())
    expect(onDismiss).toHaveBeenCalledExactlyOnceWith('disabled_custom_fallback')
  })

  it('renders nothing when there are no notices', async () => {
    await renderList([], vi.fn())
    expect(document.body.querySelector('[role="status"]')).toBeNull()
  })
})
