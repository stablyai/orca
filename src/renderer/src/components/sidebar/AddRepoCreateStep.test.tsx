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
  it('renders the name-first create UI with advanced controls collapsed', () => {
    const html = renderCreateStep()

    expect(html).toContain('Create a new project')
    expect(html).toContain('Name')
    expect(html).toContain('Git repository in ~/orca/projects')
    // The summary card itself is the collapsed disclosure for the uncommon settings.
    expect(html).toContain('aria-expanded="false"')
    expect(html).not.toContain('Project kind')
    expect(html).not.toContain('Location</span>')
    expect(html).not.toContain('aria-label="Browse host filesystem"')
  })

  it('shows the Git-required explanation in the collapsed summary', () => {
    const html = renderCreateStep({
      createName: 'demo-project',
      gitAvailability: 'unavailable'
    })

    expect(html).toContain('Git repository in ~/orca/projects')
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
