import type { GlobalSettings } from '../global-settings-types'

declare const exhaustiveBrand: unique symbol
type ExhaustiveValues<T> = readonly T[] & { readonly [exhaustiveBrand]: true }

// Checks a value no list can enumerate, such as a plugin-provided language id.
export type PortableValueGuard<T> = (value: unknown) => value is NonNullable<T>

// A string-pattern member (e.g. `plugin:${string}`) cannot be listed, so it falls back to 'string'.
type HasPatternMember<T extends string> = true extends (
  T extends string ? ({} extends Record<T, 1> ? true : false) : never
)
  ? true
  : false

type ValueSpecFor<T> = [NonNullable<T>] extends [boolean]
  ? 'boolean'
  : [NonNullable<T>] extends [number]
    ? 'number'
    : [NonNullable<T>] extends [string]
      ? string extends NonNullable<T>
        ? 'string'
        : HasPatternMember<NonNullable<T>> extends true
          ? 'string' | PortableValueGuard<T>
          : ExhaustiveValues<NonNullable<T>>
      : never

export type PortableValueSpec =
  | 'boolean'
  | 'number'
  | 'string'
  | readonly string[]
  | ((value: unknown) => boolean)

export type PortableSpecTable = {
  readonly [K in keyof GlobalSettings]?: ValueSpecFor<GlobalSettings[K]>
}

export type PortableNullableKey<S extends PortableSpecTable> = {
  [K in keyof S & keyof GlobalSettings]: null extends GlobalSettings[K] ? K : never
}[keyof S & keyof GlobalSettings]

// Returns a non-array object when a member is missing, so `satisfies PortableSpecTable` fails.
export function oneOf<K extends keyof GlobalSettings>(
  _key: K
): <const V extends readonly NonNullable<GlobalSettings[K]>[]>(
  ...values: V
) => [Exclude<NonNullable<GlobalSettings[K]>, V[number]>] extends [never]
  ? ExhaustiveValues<NonNullable<GlobalSettings[K]>>
  : { missingMembers: Exclude<NonNullable<GlobalSettings[K]>, V[number]> } {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the conditional return type only resolves once every member is listed; the runtime value is always the plain array.
  return (...values) => values as never
}
