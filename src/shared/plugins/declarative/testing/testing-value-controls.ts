import { PLUGIN_DECLARATIVE_EDIT_PROP } from '../plugin-declarative-message-names'
import type { TestElement } from './testing-tree'

type ControlState = { value: string | boolean; sent: number }
export type ControlEdit = { value: string | boolean; id: number }

const VALUE_PROP: Record<string, 'value' | 'checked'> = {
  Input: 'value',
  Select: 'value',
  Switch: 'checked'
}

/**
 * What Orca shows in each Input, Switch and Select, owned as Orca owns it: typing stays until the
 * panel renders a value having seen the edit (see the edit protocol in the components runtime).
 */
export function createValueControls() {
  let states = new Map<string, ControlState>()

  function current(element: TestElement): ControlState {
    const known = states.get(element.path)
    if (known) {
      return known
    }
    const prop = VALUE_PROP[element.type]
    if (!prop) {
      throw new Error(`a ${element.type} has no value; expected an Input, Switch or Select`)
    }
    const remote = element.props[prop]
    const fallback = element.props[prop === 'checked' ? 'defaultChecked' : 'defaultValue']
    const value = remote ?? fallback ?? (prop === 'checked' ? false : '')
    const state = { value: typeof value === 'boolean' ? value : String(value), sent: 0 }
    states.set(element.path, state)
    return state
  }

  function edit(element: TestElement, value: string | boolean): ControlEdit {
    const prop = VALUE_PROP[element.type]
    if (prop && element.props[prop] !== undefined && element.props.onChange === undefined) {
      throw new Error(`the ${element.type} is read-only: it has a ${prop} and no onChange`)
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
        const prop = VALUE_PROP[element.type]
        if (!prop) {
          continue
        }
        const state = states.get(element.path) ?? current(element)
        const remote = element.props[prop]
        const acked = element.props[PLUGIN_DECLARATIVE_EDIT_PROP]
        if (remote !== undefined && (typeof acked === 'number' ? acked : 0) >= state.sent) {
          state.value = typeof remote === 'boolean' ? remote : String(remote)
        }
        next.set(element.path, state)
      }
      states = next
    },
    valueOf: (element: TestElement): string | boolean => current(element).value,
    typeInto(element: TestElement, text: string, replace: boolean): ControlEdit[] {
      if (element.type !== 'Input') {
        throw new Error(`type: a ${element.type} takes no text; expected an Input`)
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
      if (element.type !== 'Switch') {
        throw new Error(`toggle: expected a Switch, not a ${element.type}`)
      }
      return edit(element, !current(element).value)
    },
    select(element: TestElement, value: string): ControlEdit {
      if (element.type !== 'Select') {
        throw new Error(`select: expected a Select, not a ${element.type}`)
      }
      const options = Array.isArray(element.props.options) ? element.props.options : []
      const option: unknown = options.find(
        (entry: unknown) =>
          typeof entry === 'object' && entry !== null && 'value' in entry && entry.value === value
      )
      if (
        !option ||
        (typeof option === 'object' && 'disabled' in option && option.disabled === true)
      ) {
        throw new Error(`select: the Select has no enabled option "${value}"`)
      }
      return edit(element, value)
    }
  }
}
