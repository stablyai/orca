/** JSX element factory for the guest `orca` module. Elements are plain data until rendered. */

export const ORCA_ELEMENT = Symbol.for('orca.declarative.element')
export const Fragment = Symbol.for('orca.declarative.fragment')

export type OrcaProps = Record<string, unknown>
/** Loosely typed on purpose: author-facing prop types live in the published `orca` typings. */
export type OrcaComponent = (props: OrcaProps) => unknown
export type OrcaElementType = string | typeof Fragment | OrcaComponent

export type OrcaElement = {
  readonly $$typeof: typeof ORCA_ELEMENT
  readonly type: OrcaElementType
  readonly props: OrcaProps
  readonly key: string | undefined
}

export function isOrcaElement(value: unknown): value is OrcaElement {
  return (
    typeof value === 'object' &&
    value !== null &&
    '$$typeof' in value &&
    value.$$typeof === ORCA_ELEMENT
  )
}

function createElement(type: OrcaElementType, props: OrcaProps, key: unknown): OrcaElement {
  return Object.freeze({
    $$typeof: ORCA_ELEMENT,
    type,
    props,
    key: key === undefined || key === null ? undefined : String(key)
  })
}

/** Automatic runtime (`jsx`/`jsxs`/`jsxDEV`): children arrive inside `props`. */
export function jsx(type: OrcaElementType, props: OrcaProps | null, key?: unknown): OrcaElement {
  const { key: propKey, ...rest } = props ?? {}
  return createElement(type, rest, key ?? propKey)
}

/** Classic runtime (`h`, `jsxFactory`): children arrive as trailing arguments. */
export function h(
  type: OrcaElementType,
  props: OrcaProps | null,
  ...children: unknown[]
): OrcaElement {
  const { key, ...rest } = props ?? {}
  if (children.length > 0) {
    rest.children = children.length === 1 ? children[0] : children
  }
  return createElement(type, rest, key)
}
