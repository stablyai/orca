// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ConfirmationDialogContext } from '@/components/confirmation-dialog-context'
import { TooltipProvider } from '@/components/ui/tooltip'
import { getDefaultSettings } from '../../../../shared/constants'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { getDefaultSourceControlAiSettings } from '../../../../shared/source-control-ai-settings'
import type {
  SourceControlAiSettings,
  SourceControlAiSettingsPatch
} from '../../../../shared/source-control-ai-types'
import type { SourceControlCustomAction } from '../../../../shared/source-control-custom-actions'
import {
  SourceControlCustomActionsPane,
  upsertSourceControlCustomAction
} from './SourceControlCustomActionsPane'
import {
  isSourceControlCustomActionDraftSavable,
  sourceControlCustomActionFromDraft
} from './SourceControlCustomActionDialog'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const reviewAction: SourceControlCustomAction = {
  id: 'review',
  label: 'Review',
  commandInputTemplate: '/code-review {prUrl} xhigh --comment with codex.'
}

function settingsWith(customActions?: SourceControlCustomAction[]): GlobalSettings {
  return {
    ...getDefaultSettings('/home/me'),
    sourceControlAi: { ...getDefaultSourceControlAiSettings(), customActions }
  }
}

function setFieldValue(field: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const prototype =
    field instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(field, value)
  field.dispatchEvent(new Event('input', { bubbles: true }))
}

function applyPatch(
  patch: SourceControlAiSettingsPatch,
  current: SourceControlAiSettings
): Partial<SourceControlAiSettings> {
  return typeof patch === 'function' ? patch(current) : patch
}

describe('upsertSourceControlCustomAction', () => {
  it('appends a new action and replaces an existing one in place', () => {
    const lint = { id: 'lint', label: 'Lint', commandInputTemplate: 'lint {prUrl}' }
    expect(upsertSourceControlCustomAction(undefined, reviewAction)).toEqual([reviewAction])
    expect(
      upsertSourceControlCustomAction([reviewAction, lint], {
        ...reviewAction,
        label: 'Deep review'
      })
    ).toEqual([{ ...reviewAction, label: 'Deep review' }, lint])
  })
})

describe('custom action drafts', () => {
  it('trims fields and omits the default agent and empty CLI arguments', () => {
    expect(
      sourceControlCustomActionFromDraft({
        id: 'review',
        label: ' Review ',
        agentId: null,
        agentArgs: '  ',
        commandInputTemplate: ' /code-review {prUrl} '
      })
    ).toEqual({ id: 'review', label: 'Review', commandInputTemplate: '/code-review {prUrl}' })
  })

  it('requires a label and a prompt', () => {
    const draft = {
      id: 'review',
      label: 'Review',
      agentId: null,
      agentArgs: '',
      commandInputTemplate: '/code-review {prUrl}'
    }
    expect(isSourceControlCustomActionDraftSavable(draft)).toBe(true)
    expect(isSourceControlCustomActionDraftSavable({ ...draft, label: ' ' })).toBe(false)
    expect(isSourceControlCustomActionDraftSavable({ ...draft, commandInputTemplate: '' })).toBe(
      false
    )
  })
})

describe('SourceControlCustomActionsPane', () => {
  let container: HTMLDivElement
  let root: Root
  const confirm = vi.fn()

  beforeEach(() => {
    confirm.mockReset()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    document.body.replaceChildren()
  })

  async function renderPane(
    settings: GlobalSettings,
    write: (patch: SourceControlAiSettingsPatch) => Promise<void>
  ): Promise<void> {
    await act(async () => {
      root.render(
        <ConfirmationDialogContext.Provider value={confirm}>
          <TooltipProvider>
            <SourceControlCustomActionsPane
              settings={settings}
              searchQuery=""
              writeSourceControlAiSettings={write}
            />
          </TooltipProvider>
        </ConfirmationDialogContext.Provider>
      )
    })
  }

  function findButton(label: string): HTMLButtonElement | undefined {
    return Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent === label || button.getAttribute('aria-label') === label
    )
  }

  it('saves a new action from the dialog', async () => {
    const write = vi.fn().mockResolvedValue(undefined)
    await renderPane(settingsWith(), write)
    expect(container.textContent).toContain('No custom actions yet')

    await act(async () => {
      findButton('Add action')?.click()
    })
    const label = document.querySelector<HTMLInputElement>('#source-control-custom-action-label')
    const prompt = document.querySelector<HTMLTextAreaElement>(
      '#source-control-custom-action-template'
    )
    expect(label).not.toBeNull()
    expect(prompt?.placeholder).toBe('/code-review {prUrl} xhigh --comment with codex.')
    expect(findButton('Save')?.disabled).toBe(true)

    await act(async () => {
      setFieldValue(label!, 'Review')
      setFieldValue(prompt!, '/code-review {prUrl} xhigh --comment with codex.')
    })
    await act(async () => {
      findButton('Save')?.click()
    })

    expect(write).toHaveBeenCalledTimes(1)
    const patch = applyPatch(write.mock.calls[0][0], getDefaultSourceControlAiSettings())
    expect(patch.customActions).toEqual([
      {
        id: expect.any(String),
        label: 'Review',
        commandInputTemplate: '/code-review {prUrl} xhigh --comment with codex.'
      }
    ])
  })

  it('deletes an action only after confirmation', async () => {
    const write = vi.fn().mockResolvedValue(undefined)
    await renderPane(settingsWith([reviewAction]), write)
    expect(container.textContent).toContain('Review')

    confirm.mockResolvedValueOnce(false)
    await act(async () => {
      findButton('Remove Review')?.click()
    })
    expect(write).not.toHaveBeenCalled()

    confirm.mockResolvedValueOnce(true)
    await act(async () => {
      findButton('Remove Review')?.click()
    })
    expect(write).toHaveBeenCalledTimes(1)
    const current = { ...getDefaultSourceControlAiSettings(), customActions: [reviewAction] }
    expect(applyPatch(write.mock.calls[0][0], current).customActions).toEqual([])
  })
})
