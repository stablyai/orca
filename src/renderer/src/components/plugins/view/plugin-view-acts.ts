import {
  describeQuery,
  innermost,
  listElements,
  matchesQuery,
  type TestElement
} from '../../../../../shared/plugins/declarative/testing/testing-tree'
import { visibleElements } from '../../../../../shared/plugins/declarative/testing/testing-visibility'
import { optionsOf } from '../../../../../shared/plugins/declarative/testing/testing-panel-actions'
import { isControlValue } from '../../../../../shared/plugins/declarative/testing/testing-value-controls'
import type {
  PluginShotAct,
  PluginShotActResult,
  PluginShotQuery
} from '../../../../../shared/plugins/view/plugin-shot-acts'
import type {
  PluginDeclarativeActTarget,
  PluginDeclarativeDrawnProps
} from '../declarative/plugin-declarative-act-targets'
import type { PluginPanelActDriver } from '../../right-sidebar/plugin-panel-act-driver'

export type PluginPanelActDeps = {
  driver: PluginPanelActDriver
  targetOf(props: PluginDeclarativeDrawnProps): PluginDeclarativeActTarget | null
  /** Resolves once the panel has drawn what the last act caused. */
  settle(): Promise<void>
}

const NOT_RUN = 'not run: an earlier action failed'

function callbackId(value: unknown): string | null {
  return typeof value === 'object' &&
    value !== null &&
    '$callback' in value &&
    typeof value.$callback === 'string'
    ? value.$callback
    : null
}

const TAKES = {
  type: { types: ['Input', 'Textarea'], words: 'an Input or Textarea' },
  select: { types: ['Select', 'RadioGroup', 'Tabs'], words: 'a Select, RadioGroup or Tabs' },
  toggle: {
    types: ['Switch', 'Checkbox', 'Collapsible'],
    words: 'a Switch, Checkbox or Collapsible'
  }
}

function expectTaken(element: TestElement, verb: keyof typeof TAKES): void {
  if (!TAKES[verb].types.includes(element.type)) {
    throw new Error(`${verb}: expected ${TAKES[verb].words}, not a ${element.type}`)
  }
}

/** Runs each act on what Orca draws, as the test kit's verbs do; stops at the first failure. */
export async function runPluginPanelActs(
  acts: readonly PluginShotAct[],
  { driver, targetOf, settle }: PluginPanelActDeps
): Promise<PluginShotActResult[]> {
  const valueOf = (element: TestElement) => {
    const value = targetOf(element.props)?.value()
    return isControlValue(value) ? value : ''
  }
  const elements = (): TestElement[] => visibleElements(listElements(driver.tree()), valueOf)
  const resolve = (query: PluginShotQuery, verb: string): TestElement => {
    const found = innermost(elements().filter((element) => matchesQuery(element, query)))[0]
    if (!found) {
      throw new Error(`${verb}: nothing in the panel matches { ${describeQuery(query)} }`)
    }
    if (found.disabled) {
      throw new Error(`${verb}: the ${found.type} is disabled`)
    }
    return found
  }
  const editable = (element: TestElement, verb: string): PluginDeclarativeActTarget => {
    const target = targetOf(element.props)
    if (!target) {
      throw new Error(`${verb}: the ${element.type} is not on screen`)
    }
    if (target.readOnly()) {
      throw new Error(`${verb}: the ${element.type} is read-only (a value and no onChange)`)
    }
    return target
  }
  const change = (target: PluginDeclarativeActTarget, next: unknown, verb: string): void => {
    if (!target.change(next)) {
      throw new Error(`${verb}: the control does not take ${JSON.stringify(next)}`)
    }
  }
  const send = async (callback: string | null, args: string[], missing: string) => {
    if (callback === null) {
      throw new Error(missing)
    }
    driver.send(callback, args)
    await settle()
  }

  const run = async (act: PluginShotAct): Promise<void> => {
    if ('press' in act) {
      const element = resolve(act.press, 'press')
      const onPress = callbackId(element.props.onPress)
      // Acts are not a person's input: a Link's href stays unopened and no gesture is granted.
      await send(
        onPress,
        [],
        element.type === 'Link' && typeof element.props.href === 'string'
          ? "press: --act does not open a Link's href; only a person's click does"
          : `press: the ${element.type} has no onPress`
      )
      return
    }
    if ('type' in act) {
      const element = resolve(act.type, 'type')
      expectTaken(element, 'type')
      const target = editable(element, 'type')
      let value = act.replace ? '' : String(target.value())
      if (act.replace) {
        change(target, value, 'type')
      }
      for (const character of act.text) {
        value += character
        change(target, value, 'type')
      }
      await settle()
      if (act.submit) {
        await send(
          callbackId(element.props.onSubmit),
          [String(target.value())],
          `type: the ${element.type} has no onSubmit`
        )
      }
      return
    }
    if ('select' in act) {
      const element = resolve(act.select, 'select')
      expectTaken(element, 'select')
      const option = optionsOf(element, elements()).find((entry) => entry.value === act.value)
      if (!option || option.disabled) {
        throw new Error(`select: the ${element.type} has no enabled option "${act.value}"`)
      }
      change(editable(element, 'select'), act.value, 'select')
      await settle()
      return
    }
    const element = resolve(act.toggle, 'toggle')
    expectTaken(element, 'toggle')
    const target = editable(element, 'toggle')
    change(target, target.value() !== true, 'toggle')
    await settle()
  }

  const results: PluginShotActResult[] = []
  for (const act of acts) {
    if (results.some((result) => !result.ok)) {
      results.push({ ok: false, error: NOT_RUN })
      continue
    }
    try {
      await run(act)
      results.push({ ok: true })
    } catch (error) {
      results.push({ ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  }
  return results
}
