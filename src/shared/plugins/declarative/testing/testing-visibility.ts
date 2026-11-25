import type { TestElement } from './testing-tree'
import type { ControlValue } from './testing-value-controls'

const isUnder = (element: TestElement, parent: TestElement): boolean =>
  element.path.startsWith(`${parent.path}/`)

/** The Tab elements directly inside `tabs`. */
export function tabsOf(tabs: TestElement, elements: readonly TestElement[]): TestElement[] {
  return elements.filter(
    (element) =>
      element.type === 'Tab' &&
      isUnder(element, tabs) &&
      !element.path.slice(tabs.path.length + 1).includes('/')
  )
}

/** The tab Orca shows: the value when one of the tabs has it, else the first enabled tab. */
export function activeTab(
  tabs: TestElement,
  elements: readonly TestElement[],
  value: ControlValue
): TestElement | undefined {
  const items = tabsOf(tabs, elements)
  return items.find((tab) => tab.props.value === value) ?? items.find((tab) => !tab.disabled)
}

/** What Orca draws: no content of unselected tabs or closed Collapsibles. */
export function visibleElements(
  elements: readonly TestElement[],
  valueOf: (element: TestElement) => ControlValue
): TestElement[] {
  const hidden: TestElement[] = []
  for (const element of elements) {
    if (hidden.some((parent) => isUnder(element, parent))) {
      continue
    }
    if (element.type === 'Collapsible' && valueOf(element) !== true) {
      hidden.push(element)
    }
    if (element.type === 'Tabs') {
      const shown = activeTab(element, elements, valueOf(element))
      hidden.push(...tabsOf(element, elements).filter((tab) => tab !== shown))
    }
  }
  return elements.filter((element) => !hidden.some((parent) => isUnder(element, parent)))
}
