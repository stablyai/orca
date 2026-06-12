import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { Dialog } from '@/components/ui/dialog'
import { TooltipProvider } from '@/components/ui/tooltip'
import { CreateStep } from './AddRepoCreateStep'
import type { GitAvailability } from './create-project-defaults'

function renderCreateStep({
  createName = '',
  gitAvailability = 'available',
  createParent = '/Users/alice/orca/projects',
  parentDefaultPending = false
}: {
  createName?: string
  gitAvailability?: GitAvailability
  createParent?: string
  parentDefaultPending?: boolean
} = {}): string {
  return renderToStaticMarkup(
    <TooltipProvider>
      <Dialog open>
        <CreateStep
          createName={createName}
          createParent={createParent}
          createError={null}
          isCreating={false}
          defaultParent="/Users/alice/orca/projects"
          gitAvailability={gitAvailability}
          runtimeParentStatus="idle"
          parentDefaultPending={parentDefaultPending}
          onNameChange={vi.fn()}
          onParentChange={vi.fn()}
          onPickParent={vi.fn()}
          onCreate={vi.fn()}
        />
      </Dialog>
    </TooltipProvider>
  )
}

describe('CreateStep', () => {
  it('renders the conductor-style Git project form without templates or kind selection', () => {
    const html = renderCreateStep()

    expect(html).toContain('Create project')
    expect(html).toContain('Project name')
    expect(html).not.toContain('Git repo:')
    expect(html).not.toContain('>project-name</span>')
    expect(html).toContain('Parent folder')
    expect(html).toContain('Browse')
    expect(html).not.toContain('Template')
    expect(html).not.toContain('Project kind')
  })

  it('shows the repo name in the helper only after a project name is entered', () => {
    const html = renderCreateStep({ createName: 'demo-project' })

    expect(html).toContain('Git repo:')
    expect(html).toContain('demo-project')
  })

  it('requires Git instead of falling back to folder creation', () => {
    const html = renderCreateStep({ gitAvailability: 'unavailable' })

    expect(html).toContain('Git is required to create a project.')
    expect(html).toContain('disabled=""')
  })

  it('disables create while an auto-filled parent belongs to a previous target', () => {
    const html = renderCreateStep({
      createName: 'demo-project',
      parentDefaultPending: true
    })

    expect(html).toContain('disabled=""')
  })
})
