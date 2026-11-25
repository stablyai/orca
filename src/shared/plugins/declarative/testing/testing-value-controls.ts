import {
  PLUGIN_DECLARATIVE_EDIT_PROP,
  pluginDeclarativeValueControl
} from '../plugin-declarative-message-names'
import type { TestElement } from './testing-tree'

/** What a value control holds: text, a flag, a number (Slider) or keys (Table selection). */
export type ControlValue = string | boolean | number | readonly string[]
type ControlState = { value: ControlValue; sent: number }
export type ControlEdit = { value: ControlValue; id: number }

const DEFAULT_PROP: Record<string, string> = {
  value: 'defaultValue',
  checked: 'defaultChecked',
  open: 'defaultOpen',
  selected: 'defaultSelected'
}

export function isControlValue(value: unknown): value is ControlValue {
  return (
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    typeof value === 'number' ||
    (Array.isArray(value) && value.every((entry) => typeof entry === 'string'))
  )
}

function fallbackOf(element: TestElement): ControlValue {
  switch (element.type) {
    case 'Switch':
    case 'Checkbox':
    case 'Collapsible':
      return false
    case 'Slider':
      return typeof element.props.min === 'number' ? element.props.min : 0
    case 'Table':
      return []
    default:
      return ''
  }
}

/**
 * What Orca shows in each value control, owned as Orca owns it: an edit stays until the panel
 * renders a value having seen it (see the edit protocol in the components runtime).
 */
export function createValueControls() {
  let states = new Map<string, ControlState>()

  function control(element: TestElement): { value: string; change: string } {
    const found = pluginDeclarativeValueControl(element.type)
    if (!found) {
      throw new Error(`a ${element.type} has no value; expected a form control, Tabs or Table`)
    }
    return found
  }

  function current(element: TestElement): ControlState {
    const known = states.get(element.path)
    if (known) {
      return known
    }
    const { value: prop } = control(element)
    const remote = element.props[prop]
    const seeded = element.props[DEFAULT_PROP[prop] ?? '']
    const value = isControlValue(remote)
      ? remote
      : isControlValue(seeded)
        ? seeded
        : fallbackOf(element)
    const state = { value, sent: 0 }
    states.set(element.path, state)
    return state
  }

  function edit(element: TestElement, value: ControlValue): ControlEdit {
    const { value: prop, change } = control(element)
    if (element.props[prop] !== undefined && element.props[change] === undefined) {
      throw new Error(`the ${element.type} is read-only: it has a ${prop} and no ${change}`)
    }
    const state = current(element)
    state.sent += 1
    state.value = value
    return { value, id: state.sent }
  }

  return {
    /** A new tree: adopt each control's value once the panel has seen every edit. */
    observe(elements: readonly TestElement[]): void {
      const next = new Map<string, ControlState>()
      for (const element of elements) {
        const found = pluginDeclarativeValueControl(element.type)
        if (!found) {
          continue
        }
        const state = states.get(element.path) ?? current(element)
        const remote = element.props[found.value]
        const acked = element.props[PLUGIN_DECLARATIVE_EDIT_PROP]
        if (isControlValue(remote) && (typeof acked === 'number' ? acked : 0) >= state.sent) {
          state.value = remote
        }
        next.set(element.path, state)
      }
      states = next
    },
    valueOf: (element: TestElement): ControlValue => current(element).value,
    edit,
    typeInto(element: TestElement, text: string, replace: boolean): ControlEdit[] {
      if (element.type !== 'Input' && element.type !== 'Textarea') {
        throw new Error(`type: a ${element.type} takes no text; expected an Input or Textarea`)
      }
      let value = replace ? '' : String(current(element).value)
      const edits: ControlEdit[] = []
      if (replace) {
        edits.push(edit(element, value))
      }
      for (const character of text) {
        value += character
        edits.push(edit(element, value))
      }
      return edits
    },
    toggle(element: TestElement): ControlEdit {
      if (!['Switch', 'Checkbox', 'Collapsible'].includes(element.type)) {
        throw new Error(`toggle: expected a Switch, Checkbox or Collapsible, not a ${element.type}`)
      }
      return edit(element, !current(element).value)
    }
  }
}
