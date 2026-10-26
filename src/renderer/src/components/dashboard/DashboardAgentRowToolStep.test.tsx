import { renderToStaticMarkup } from 'react-dom/server'
import type { ComponentProps } from 'react'
import { describe, expect, it } from 'vitest'
import { DashboardAgentRowToolStep } from './DashboardAgentRowToolStep'

function renderStep(props: Partial<ComponentProps<typeof DashboardAgentRowToolStep>>): string {
  return renderToStaticMarkup(
    <DashboardAgentRowToolStep
      expanded={false}
      showsTool
      reservesHeight={false}
      toolName=""
      toolInput=""
      {...props}
    />
  )
}

describe('DashboardAgentRowToolStep', () => {
  it('shows a program message alone when no tool is named', () => {
    const markup = renderStep({ toolInput: 'Pouring wget' })

    expect(markup).toContain('data-agent-row-tool-input="true"')
    expect(markup).toContain('Pouring wget')
    expect(markup).not.toContain('lucide-wrench')
    expect(markup).not.toContain('data-agent-row-tool-header')
    expect(markup).not.toContain('data-agent-row-tool-placeholder')
  })

  it('keeps the placeholder when neither a tool nor input is known yet', () => {
    const markup = renderStep({ reservesHeight: true })

    expect(markup).toContain('data-agent-row-tool-placeholder="true"')
    expect(markup).not.toContain('data-agent-row-tool-input')
  })

  it('renders nothing with no tool, no input and no reserved height', () => {
    expect(renderStep({})).toBe('')
  })

  it('keeps the wrench header when a tool is named', () => {
    const markup = renderStep({ toolName: 'bash', toolInput: 'ls' })

    expect(markup).toContain('lucide-wrench')
    expect(markup).not.toContain('data-agent-row-tool-input')
  })
})
