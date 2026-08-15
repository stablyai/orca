// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type {
  DiscoveredSkill,
  SkillDiscoveryResult,
  SkillSourceKind
} from '../../../../shared/skills'
import { SkillsGallery } from './SkillsGallery'
import { SkillsSourceFilterChips } from './SkillsFilterBar'
import { SkillsGalleryGrid } from './SkillsGalleryGrid'

function skill(overrides: Partial<DiscoveredSkill>): DiscoveredSkill {
  return {
    id: 'id',
    name: 'Review',
    description: 'Code review',
    providers: ['codex'],
    sourceKind: 'home',
    sourceLabel: 'Codex home',
    rootPath: '/root',
    directoryPath: '/root/review',
    skillFilePath: '/root/review/SKILL.md',
    installed: true,
    fileCount: 1,
    updatedAt: Date.now(),
    ...overrides
  }
}

function render(element: React.ReactElement): { root: Root; container: HTMLDivElement } {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => {
    root.render(<TooltipProvider>{element}</TooltipProvider>)
  })
  return { root, container }
}

async function flushEffects(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe('Skills gallery redesign', () => {
  let root: Root | null = null
  let container: HTMLDivElement | null = null

  afterEach(() => {
    if (root) {
      act(() => root?.unmount())
    }
    container?.remove()
    root = null
    container = null
    Reflect.deleteProperty(window, 'api')
  })

  it('renders skills in a responsive gallery grid and marks duplicate locations', () => {
    ;({ root, container } = render(
      <SkillsGalleryGrid
        skills={[
          skill({ id: 'home', name: 'composio-cli', sourceKind: 'home' }),
          skill({
            id: 'plugin',
            name: 'composio-cli',
            sourceKind: 'plugin',
            skillFilePath: '/plugin/composio-cli/SKILL.md'
          })
        ]}
      />
    ))

    const grid = container.querySelector('[data-testid="skills-gallery-grid"]')

    expect(grid?.className).toContain('grid-cols-[repeat(auto-fill')
    expect(container.textContent).toContain('composio-cli')
    expect(container.textContent).toContain('2 locations')
    expect(container.textContent).not.toContain('/plugin/composio-cli/SKILL.md')
  })

  it('renders source filter chips with counts and reports chip selection', () => {
    const onValueChange = vi.fn()
    const sourceCounts: Record<SkillSourceKind, number> = {
      home: 2,
      repo: 1,
      bundled: 0,
      plugin: 3
    }

    ;({ root, container } = render(
      <SkillsSourceFilterChips
        value="all"
        sourceCounts={sourceCounts}
        totalCount={6}
        onValueChange={onValueChange}
      />
    ))

    expect(container.textContent).toContain('All sources')
    expect(container.textContent).toContain('6')
    expect(container.textContent).toContain('Repository')
    expect(container.textContent).toContain('3')

    const pluginChip = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Plugin')
    )

    act(() => {
      pluginChip?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(onValueChange).toHaveBeenCalledWith('plugin')
  })

  it('filters discovered skills by search query inside the shared gallery body', async () => {
    const discoveryResult: SkillDiscoveryResult = {
      scannedAt: Date.now(),
      sources: [
        {
          id: 'home',
          label: 'Codex home',
          path: '/root',
          sourceKind: 'home',
          providers: ['codex'],
          exists: true
        }
      ],
      skills: [
        skill({ id: 'react', name: 'React Patterns', description: 'UI patterns' }),
        skill({ id: 'docs', name: 'Docs Writer', description: 'Documentation help' })
      ]
    }
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        skills: {
          discover: vi.fn().mockResolvedValue(discoveryResult)
        },
        shell: {
          openPath: vi.fn()
        }
      }
    })

    ;({ root, container } = render(<SkillsGallery />))
    await flushEffects()

    expect(container.textContent).toContain('React Patterns')
    expect(container.textContent).toContain('Docs Writer')

    const searchInput = container.querySelector('input')
    expect(searchInput).toBeTruthy()
    act(() => {
      if (!searchInput) {
        return
      }
      const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      valueSetter?.call(searchInput, 'docs')
      searchInput.dispatchEvent(new Event('input', { bubbles: true }))
    })

    expect(container.textContent).not.toContain('React Patterns')
    expect(container.textContent).toContain('Docs Writer')
  })
})
