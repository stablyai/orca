import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { TaskSourceShowInTasksStep } from './TaskSourceShowInTasksStep'

describe('TaskSourceShowInTasksStep', () => {
  it('uses an explicit hide action when another provider can remain visible', () => {
    const markup = renderToStaticMarkup(
      <TaskSourceShowInTasksStep
        index={2}
        providerLabel="GitLab"
        visible
        canHide
        onToggleVisible={vi.fn()}
      />
    )

    expect(markup).not.toContain('aria-pressed')
    expect(markup).toContain('>Hide</button>')
  })

  it('explains why the final visible provider cannot be hidden', () => {
    const markup = renderToStaticMarkup(
      <TaskSourceShowInTasksStep
        index={2}
        providerLabel="GitLab"
        visible
        canHide={false}
        onToggleVisible={vi.fn()}
      />
    )

    // aria-disabled, not disabled: the explanation must stay keyboard reachable.
    expect(markup).toContain('aria-disabled="true"')
    expect(markup).not.toContain('disabled=""')
    expect(markup).toContain(
      'aria-label="GitLab is shown in Tasks. At least one provider must stay visible."'
    )
    expect(markup).toContain('>Shown</button>')
    expect(markup).toContain('At least one provider must stay visible in Tasks.')
  })
})
