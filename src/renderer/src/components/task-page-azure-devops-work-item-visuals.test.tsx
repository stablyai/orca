// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import '@testing-library/jest-dom/vitest'
import type { AzureDevOpsWorkItemTypeMetadata } from '../../../shared/azure-devops/boards-types'
import {
  WorkItemStateDot,
  WorkItemTagChip,
  WorkItemTypeBadge,
  WorkItemTypeIcon,
  workItemStateColor
} from '@/components/task-page/azure-devops/WorkItemVisuals'

afterEach(() => cleanup())

const feature: AzureDevOpsWorkItemTypeMetadata = {
  name: 'Feature',
  color: '#773B93',
  iconId: 'icon_trophy',
  iconUrl:
    'https://tfsprodcus3.visualstudio.com/_apis/wit/workItemIcons/icon_trophy?color=773B93&v=2',
  states: [{ name: 'In Progress', color: '#007acc', category: 'InProgress' }]
}

describe('work item visuals', () => {
  it('renders the Azure DevOps icon image and falls back to the lucide glyph when it fails', () => {
    const { container } = render(<WorkItemTypeIcon metadata={feature} className="size-3.5" />)
    const image = container.querySelector('img')
    expect(image).toHaveAttribute('src', feature.iconUrl)
    expect(image).toHaveAttribute('alt', '')
    fireEvent.error(image!)
    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('svg')).not.toBeNull()
  })

  it('uses the lucide glyph when no icon url is known', () => {
    const { container } = render(<WorkItemTypeIcon metadata={{ ...feature, iconUrl: null }} />)
    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('svg')).not.toBeNull()
  })

  it('renders the type name with its colour', () => {
    render(<WorkItemTypeBadge type="Feature" metadata={feature} showName />)
    const badge = screen.getByText('Feature')
    expect(badge.closest('[data-work-item-type]')).toHaveStyle({ color: '#773B93' })
  })

  it('resolves state colour and falls back to null for unknown states', () => {
    expect(workItemStateColor('In Progress', feature)).toBe('#007acc')
    expect(workItemStateColor('Nope', feature)).toBeNull()
    expect(workItemStateColor('In Progress', undefined)).toBeNull()
  })

  it('renders a state dot with the state colour', () => {
    render(<WorkItemStateDot state="In Progress" metadata={feature} />)
    expect(screen.getByLabelText('In Progress')).toHaveStyle({ backgroundColor: '#007acc' })
  })

  it('renders a tag chip using the configured colour, with text picked by its luminance', () => {
    render(<WorkItemTagChip tag="triage" color="#1F3A5F" />)
    const dark = screen.getByText('triage')
    expect(dark).toHaveStyle({ backgroundColor: '#1F3A5F' })
    expect(dark).toHaveClass('text-white')
    render(<WorkItemTagChip tag="pink" color="#F599D1" />)
    expect(screen.getByText('pink')).toHaveClass('text-black')
  })

  it('renders an uncoloured tag chip on the muted surface with foreground text', () => {
    render(<WorkItemTagChip tag="plain" color={null} />)
    expect(screen.getByText('plain')).toHaveClass('bg-muted', 'text-foreground')
  })
})
