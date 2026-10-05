// @vitest-environment happy-dom

import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TaskPageGitLabLabelFilter } from './LabelFilter'
import { i18n } from '@/i18n/i18n'

afterEach(cleanup)

describe('GitLab task label filter', () => {
  it.each(['ja', 'ko', 'zh'])('ships a translated selected-label count for %s', async (locale) => {
    await i18n.changeLanguage(locale)
    try {
      const template: unknown = i18n.getResource(
        locale,
        'translation',
        'auto.components.TaskPage.gitlabSelectedLabelCount_other'
      )
      expect(typeof template).toBe('string')
      expect(template).toContain('{{count}}')
      expect(template).not.toMatch(/\blabels?\b/i)
      render(
        <TaskPageGitLabLabelFilter labels={[]} selected={['bug', 'frontend']} onChange={vi.fn()} />
      )
      expect(screen.getByRole('combobox').textContent).toBe(
        i18n.t('auto.components.TaskPage.gitlabSelectedLabelCount', { count: 2 })
      )
    } finally {
      await i18n.changeLanguage('en')
    }
  })

  it('marks comma-containing labels unsupported and prevents pointer selection', async () => {
    const onChange = vi.fn()
    const user = userEvent.setup()
    render(
      <TaskPageGitLabLabelFilter
        labels={['bug, urgent', 'bug']}
        selected={[]}
        onChange={onChange}
      />
    )
    await user.click(screen.getByRole('combobox', { name: /labels/i }))
    const unsupported = screen.getByRole('option', { name: /bug, urgent/i })
    await user.click(unsupported)
    expect(onChange).not.toHaveBeenCalled()
    expect(unsupported.getAttribute('aria-disabled')).toBe('true')
    expect(within(unsupported).getByText(/unsupported/i)).toBeDefined()
    await user.click(screen.getByRole('option', { name: /^bug$/i }))
    expect(onChange).toHaveBeenLastCalledWith(['bug'])
  })

  it('prevents keyboard selection of comma labels while allowing supported labels', async () => {
    const onChange = vi.fn()
    const user = userEvent.setup()
    render(
      <TaskPageGitLabLabelFilter
        labels={['bug, urgent', 'frontend']}
        selected={[]}
        onChange={onChange}
      />
    )
    await user.click(screen.getByRole('combobox', { name: /labels/i }))
    const input = screen.getByPlaceholderText('Search labels...')
    await user.type(input, 'bug,')
    await user.keyboard('{ArrowDown}{Enter}')
    expect(onChange).not.toHaveBeenCalled()
    await user.clear(input)
    await user.type(input, 'frontend')
    await user.keyboard('{ArrowDown}{Enter}')
    expect(onChange).toHaveBeenLastCalledWith(['frontend'])
  })

  it.each([
    [2, '2 метки'],
    [5, '5 меток']
  ])('uses locale plural forms for %i selected labels', async (count, expected) => {
    i18n.addResourceBundle(
      'ru',
      'translation',
      {
        auto: {
          components: {
            TaskPage: {
              gitlabLabel: 'Labels',
              gitlabSelectedLabelCount_few: '{{count}} метки',
              gitlabSelectedLabelCount_many: '{{count}} меток'
            }
          }
        }
      },
      true,
      true
    )
    await i18n.changeLanguage('ru')
    try {
      render(
        <TaskPageGitLabLabelFilter
          labels={[]}
          selected={Array.from({ length: count }, (_, index) => `label-${index}`)}
          onChange={vi.fn()}
        />
      )
      expect(screen.getByRole('combobox', { name: 'Labels' }).textContent).toBe(expected)
    } finally {
      await i18n.changeLanguage('en')
      i18n.removeResourceBundle('ru', 'translation')
    }
  })

  it('shows label loading failures instead of an empty project', async () => {
    const user = userEvent.setup()
    render(<TaskPageGitLabLabelFilter labels={[]} loadFailed selected={[]} onChange={vi.fn()} />)
    await user.click(screen.getByRole('combobox', { name: /labels/i }))
    expect(screen.getByText('Could not load labels. Try Refresh.')).toBeDefined()
  })

  it('reports partial loading failures without hiding available labels', async () => {
    const user = userEvent.setup()
    render(
      <TaskPageGitLabLabelFilter labels={['bug']} loadFailed selected={[]} onChange={vi.fn()} />
    )
    await user.click(screen.getByRole('combobox', { name: /labels/i }))
    expect(screen.getByText('Some labels could not load. Try Refresh.')).toBeDefined()
    expect(screen.getByText('bug')).toBeDefined()
  })

  it('searches labels, keeps multiple selections, and clears them together', async () => {
    const onChange = vi.fn()
    function Harness() {
      const [selected, setSelected] = useState<string[]>([])
      return (
        <TaskPageGitLabLabelFilter
          labels={['bug', 'frontend', 'needs review']}
          selected={selected}
          onChange={(next) => {
            setSelected(next)
            onChange(next)
          }}
        />
      )
    }
    const user = userEvent.setup()
    render(<Harness />)
    await user.click(screen.getByRole('combobox', { name: /labels/i }))
    await user.type(screen.getByPlaceholderText('Search labels...'), 'needs')
    expect(screen.getByText('needs review')).toBeDefined()
    expect(screen.queryByText('frontend')).toBeNull()
    await user.click(screen.getByText('needs review'))
    expect(onChange).toHaveBeenLastCalledWith(['needs review'])
    await user.clear(screen.getByPlaceholderText('Search labels...'))
    await user.click(screen.getByText('bug'))
    expect(onChange).toHaveBeenLastCalledWith(['needs review', 'bug'])
    await user.click(screen.getByText('All labels'))
    expect(onChange).toHaveBeenLastCalledWith([])
  })
})
