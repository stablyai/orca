// @vitest-environment happy-dom
import { afterEach, expect, it } from 'vitest'
import { InteractionManager, pluckInteractionOptions } from '@pierre/diffs'
import { canCommentOnPierreRange } from './pierre-diff-comment-range'

afterEach(() => document.body.replaceChildren())

it('hides the gutter action on original and ineligible review lines and labels eligible lines', () => {
  const pre = document.createElement('pre')
  pre.setAttribute('data-diff-type', 'split')
  for (const side of ['deletions', 'additions']) {
    const code = document.createElement('code')
    code.setAttribute('data-code', '')
    code.setAttribute(`data-${side}`, '')
    for (let line = 1; line <= 3; line++) {
      const number = document.createElement('div')
      number.setAttribute('data-column-number', String(line))
      number.setAttribute('data-line-index', `${line - 1},${line - 1}`)
      number.setAttribute('data-line-type', 'context')
      const content = number.cloneNode() as HTMLElement
      content.removeAttribute('data-column-number')
      content.setAttribute('data-line', String(line))
      content.textContent = 'example'
      code.append(number, content)
    }
    pre.append(code)
  }
  document.body.append(pre)
  const manager = new InteractionManager(
    'diff',
    pluckInteractionOptions(
      {
        enableGutterUtility: true,
        gutterUtilityLabel: 'Add review comment',
        canUseGutterUtility: (range) => canCommentOnPierreRange(range, new Set([1, 3]))
      },
      () => {}
    )
  )
  manager.setup(pre)
  const hover = (side: string, line: number) => {
    pre
      .querySelector(`[data-${side}] [data-line="${line}"]`)!
      .dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerType: 'mouse' }))
  }
  try {
    hover('deletions', 1)
    expect(pre.querySelector('[data-utility-button]')).toBeNull()
    hover('additions', 1)
    expect(pre.querySelector('[data-utility-button]')?.getAttribute('aria-label')).toBe(
      'Add review comment'
    )
    hover('additions', 2)
    expect(pre.querySelector('[data-utility-button]')).toBeNull()
    hover('additions', 3)
    expect(pre.querySelector('[data-utility-button]')?.getAttribute('title')).toBe(
      'Add review comment'
    )
  } finally {
    manager.cleanUp()
  }
})
