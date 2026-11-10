// @vitest-environment happy-dom
import { cleanup, renderHook } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { ORCA_CLOUD_IMAGE_AGENTS } from '../../../../shared/hosted-sandbox/orca-cloud-image-agents'
import type { EphemeralVmRecipeOption } from './new-workspace-composer-card-props'

vi.mock('@/store/index', () => ({ useAppStore: { getState: () => ({}) } }))
vi.mock('@/lib/host-chat-program', () => ({ agentChoicePending: () => false }))
// This desktop has aider and claude; the host offers exactly what it detected.
vi.mock('@/lib/host-chat-program-acquisition', () => ({
  useAgentsOfferedForLaunch: (_workspace: unknown, detected: ReadonlySet<TuiAgent> | null) =>
    detected
}))

import { useComposerQuickAgent } from './use-composer-quick-agent'

afterEach(cleanup)

const orcaCloudRecipe: EphemeralVmRecipeOption = {
  id: 'orca-cloud',
  name: 'Orca Cloud',
  create: 'orca-cloud',
  provider: 'orca-cloud'
}
const otherRecipe: EphemeralVmRecipeOption = { id: 'custom', name: 'Custom', create: './vm.sh' }

function renderComposerAgent(props: {
  recipe: EphemeralVmRecipeOption | null
  override?: TuiAgent | null
  settings?: Pick<GlobalSettings, 'defaultTuiAgent'>
}) {
  return renderHook(
    ({ recipe }: { recipe: EphemeralVmRecipeOption | null }) => {
      const [override, setOverride] = useState<TuiAgent | null | undefined>(props.override)
      return {
        override,
        ...useComposerQuickAgent(
          {
            agentRows: null,
            detectedAgentIds: new Set<TuiAgent>(['aider', 'claude']),
            repoId: 'repo-1',
            selectedRepoIsGit: true,
            selectedRepoExecutionHostId: null,
            ephemeralVmRecipes: [orcaCloudRecipe, otherRecipe],
            selectedEphemeralVmRecipeId: recipe?.id ?? null
          },
          props.settings ?? null,
          override,
          setOverride
        )
      }
    },
    { initialProps: { recipe: props.recipe } }
  )
}

describe('useComposerQuickAgent', () => {
  it('offers only the image agents and an enabled terminal-only picker for Orca Cloud', () => {
    const { result } = renderComposerAgent({
      recipe: orcaCloudRecipe,
      settings: { defaultTuiAgent: 'aider' }
    })
    expect(result.current.orcaCloud).toBe(true)
    expect(result.current.quickAgent).toBe('claude')
    expect([...(result.current.chipAgentIds ?? [])]).toEqual([...ORCA_CLOUD_IMAGE_AGENTS])
    expect(result.current.orcaCloudModel?.state).toBe('settled')
    expect(result.current.orcaCloudModel?.rows.every((row) => row.kind === 'terminal')).toBe(true)
  })

  it('never submits a local-only pick to Orca Cloud, and restores it on the local host', () => {
    const { result, rerender } = renderComposerAgent({ recipe: orcaCloudRecipe, override: 'aider' })
    expect(result.current.quickAgent).toBe('claude')
    // The pick itself is kept, so going back to this desktop restores it.
    expect(result.current.override).toBe('aider')
    rerender({ recipe: null })
    expect(result.current.orcaCloud).toBe(false)
    expect(result.current.quickAgent).toBe('aider')
  })

  it('keeps a default the image ships', () => {
    const { result } = renderComposerAgent({
      recipe: orcaCloudRecipe,
      settings: { defaultTuiAgent: 'gemini' }
    })
    expect(result.current.quickAgent).toBe('gemini')
  })

  it('leaves other VM recipes on this host inventory', () => {
    const { result } = renderComposerAgent({
      recipe: otherRecipe,
      settings: { defaultTuiAgent: 'aider' }
    })
    expect(result.current.orcaCloud).toBe(false)
    expect(result.current.orcaCloudModel).toBeNull()
    expect(result.current.quickAgent).toBe('aider')
    expect([...(result.current.chipAgentIds ?? [])].sort()).toEqual(['aider', 'claude'])
  })
})
