// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  addEventListenerOnAllDocuments,
  getAuxPaneContainerForDocument,
  getAuxPaneGroupIdForTarget,
  getPaneDocuments,
  registerAuxPaneContainer,
  unregisterAuxPaneContainer
} from './aux-pane-window-registry'

const GROUP_ID = 'aux-group'

afterEach(() => {
  unregisterAuxPaneContainer(GROUP_ID)
})

describe('aux pane document registry', () => {
  it('resolves targets and keeps document listeners synchronized', () => {
    const auxDocument = document.implementation.createHTMLDocument('Aux')
    const container = auxDocument.createElement('div')
    const target = auxDocument.createElement('button')
    container.append(target)
    registerAuxPaneContainer(GROUP_ID, container)

    expect(getAuxPaneGroupIdForTarget(target)).toBe(GROUP_ID)
    expect(getAuxPaneContainerForDocument(auxDocument)).toBe(container)
    expect(getPaneDocuments()).toContain(auxDocument)

    const handler = vi.fn()
    const remove = addEventListenerOnAllDocuments('mousedown', handler)
    auxDocument.dispatchEvent(new Event('mousedown'))
    expect(handler).toHaveBeenCalledOnce()

    unregisterAuxPaneContainer(GROUP_ID)
    auxDocument.dispatchEvent(new Event('mousedown'))
    expect(handler).toHaveBeenCalledOnce()
    remove()
  })
})
