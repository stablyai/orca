import { fetchesCustomCssResource } from '../../../shared/custom-css'

type CssRuleNode = { readonly cssText: string }
type CssRuleContainer = {
  readonly cssRules: ArrayLike<CssRuleNode>
  deleteRule(index: number): void
}

function hasStyle(rule: CssRuleNode): rule is CssRuleNode & { style: CSSStyleDeclaration } {
  return 'style' in rule && rule.style instanceof CSSStyleDeclaration
}

function isContainer(rule: CssRuleNode): rule is CssRuleNode & CssRuleContainer {
  return 'cssRules' in rule && 'deleteRule' in rule
}

/** Removes every declaration that fetches; a rule whose values CSSOM cannot expose (e.g. @property) is deleted instead. */
export function stripResourceFetches(container: CssRuleContainer): void {
  for (let index = container.cssRules.length - 1; index >= 0; index--) {
    const rule = container.cssRules[index]
    if (hasStyle(rule)) {
      // Why: CSSOM hands back longhands serialized by Chromium, not the user's spelling.
      for (const property of Array.from(rule.style)) {
        if (fetchesCustomCssResource(rule.style.getPropertyValue(property))) {
          rule.style.removeProperty(property)
        }
      }
    }
    if (isContainer(rule)) {
      stripResourceFetches(rule)
    } else if (!hasStyle(rule) && fetchesCustomCssResource(rule.cssText)) {
      container.deleteRule(index)
    }
  }
}

/** Parses with Chromium's own CSS parser: constructed sheets drop `@import` by spec, and every reference but an inline `data:` URL is removed. */
export function buildCustomCssSheet(css: string): CSSStyleSheet {
  const sheet = new CSSStyleSheet()
  sheet.replaceSync(css)
  stripResourceFetches(sheet)
  return sheet
}

const appliedSheets = new WeakMap<Document, CSSStyleSheet>()

/** Swaps the document's custom sheet; adopted sheets cascade after every `<link>`/`<style>`, so it always wins ties. */
export function applyCustomCssSheet(doc: Document, sheet: CSSStyleSheet | null): void {
  const previous = appliedSheets.get(doc)
  const others = doc.adoptedStyleSheets.filter((existing) => existing !== previous)
  doc.adoptedStyleSheets = sheet ? [...others, sheet] : others
  if (sheet) {
    appliedSheets.set(doc, sheet)
  } else {
    appliedSheets.delete(doc)
  }
}
