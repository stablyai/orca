// @vitest-environment happy-dom

import { useState } from 'react'
import { act } from '@testing-library/react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TaskPromptTemplateSetting } from './TaskPromptTemplateSetting'

vi.mock('./SearchableSetting', () => ({
  SearchableSetting: ({ children }: { children: React.ReactNode }) => <div>{children}</div>
}))

let root: Root | null = null
let container: HTMLDivElement | null = null

afterEach(async () => {
  await act(async () => root?.unmount())
  container?.remove()
  root = null
  container = null
})

async function renderSetting(scope: 'global' | 'project', value = '') {
  const commit = vi.fn<(_: string) => Promise<boolean>>().mockResolvedValue(true)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  function ControlledSetting() {
    const [savedValue, setSavedValue] = useState(value)
    return (
      <TaskPromptTemplateSetting
        scope={scope}
        value={savedValue}
        commit={async (next) => {
          const result = await commit(next)
          if (result) {
            setSavedValue(next)
          }
          return result
        }}
        globalTemplate="{{url}} /global-skill"
      />
    )
  }
  await act(async () => {
    root?.render(<ControlledSetting />)
  })
  const textarea = container.querySelector('textarea')
  const reset = container.querySelector('button')
  if (!textarea || !reset) {
    throw new Error('Missing prompt controls')
  }
  return { textarea, reset, commit }
}

describe('TaskPromptTemplateSetting', () => {
  it('keeps multiline edits local until blur and resets the global prompt', async () => {
    const { textarea, reset, commit } = await renderSetting('global')
    const template = '{{url}} /jira-engineer\nStart with analysis.'
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(
        textarea,
        template
      )
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(commit).not.toHaveBeenCalled()
    expect(textarea.value).toBe(template)
    await act(async () => {
      textarea.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
    })
    expect(commit).toHaveBeenLastCalledWith(template)
    expect(reset.textContent).toBe('Reset to default')
    await act(async () => reset.click())
    expect(commit).toHaveBeenLastCalledWith('')
    expect(textarea.value).toBe('')
  })

  it('shows the inherited global template and restores inheritance for a project', async () => {
    const { textarea, reset, commit } = await renderSetting('project', '{{url}} /project-skill')
    expect(textarea.placeholder).toBe('{{url}} /global-skill')
    expect(reset.textContent).toBe('Use global prompt')
    await act(async () => reset.click())
    expect(commit).toHaveBeenCalledWith('')
    expect(textarea.value).toBe('')
    expect(reset.disabled).toBe(true)
  })

  it('shows failed project saves and retries on blur before reporting success', async () => {
    const { textarea, reset, commit } = await renderSetting('project', '{{url}} /project-skill')
    commit.mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    await act(async () => reset.click())
    expect(container?.querySelector('[role="alert"]')?.textContent).toContain('Could not save')
    expect(container?.querySelector('[role="status"]')).toBeNull()
    await act(async () => {
      textarea.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
    })
    expect(commit).toHaveBeenCalledTimes(2)
    expect(container?.querySelector('[role="alert"]')).toBeNull()
    expect(container?.querySelector('[role="status"]')?.textContent).toBe('Saved')
  })

  it('surfaces rejected saves without reporting success', async () => {
    const { reset, commit } = await renderSetting('project', '{{url}} /project-skill')
    commit.mockRejectedValueOnce(new Error('Disconnected'))
    await act(async () => reset.click())
    expect(container?.querySelector('[role="alert"]')?.textContent).toContain('Could not save')
    expect(container?.querySelector('[role="status"]')).toBeNull()
  })

  it('serializes a reset behind an in-flight save and ignores its stale prop echo', async () => {
    const first = Promise.withResolvers<boolean>()
    const resetSave = Promise.withResolvers<boolean>()
    const { commit } = await renderSetting('project')
    commit.mockReturnValueOnce(first.promise).mockReturnValueOnce(resetSave.promise)
    function ControlledSetting() {
      const [value, setValue] = useState('{{url}} /initial')
      return (
        <TaskPromptTemplateSetting
          scope="project"
          value={value}
          commit={async (next) => {
            const result = await commit(next)
            if (result) {
              setValue(next)
            }
            return result
          }}
        />
      )
    }
    await act(async () => root?.render(<ControlledSetting />))
    const textarea = container?.querySelector('textarea')
    const reset = container?.querySelector('button')
    if (!textarea || !reset) {
      throw new Error('Missing prompt controls')
    }
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(
        textarea,
        '{{url}} /first'
      )
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
      textarea.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
    })
    await act(async () => reset.click())
    expect(commit).toHaveBeenCalledTimes(1)
    expect(textarea.value).toBe('')
    await act(async () => {
      first.resolve(true)
    })
    expect(commit).toHaveBeenLastCalledWith('')
    expect(commit).toHaveBeenCalledTimes(2)
    expect(textarea.value).toBe('')
    expect(container?.querySelector('[role="status"]')).toBeNull()
    await act(async () => {
      resetSave.resolve(true)
    })
    expect(textarea.value).toBe('')
    expect(container?.querySelector('[role="status"]')?.textContent).toBe('Saved')
  })
})
