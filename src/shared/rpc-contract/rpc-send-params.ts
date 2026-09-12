import type { z } from 'zod'
import type { RPC_PARAMS_BY_METHOD, RpcMethodName } from './rpc-params-catalog.generated'

// Why this exists: neither of zod's two inferred types describes an outgoing request.
// z.output is what the handler receives *after* parsing, so a `.default(x)` field reads as
// required and a sender that legitimately omits it fails to typecheck. z.input is worse here
// — the params builders parse with z.unknown() so a hostile client cannot crash the
// dispatcher, which collapses every requiredString/OptionalString field to `unknown`.
//
// So take each channel where it is honest: key optionality from zod's own `optin` marker
// (the z.input rule, which is the one that understands .default and .optional), and value
// types from z.output (the post-coercion contract the builders declare in their pipe target).
// Derived from the generated catalog, so it cannot drift from the dispatcher.
//
// Type-level only. Never import the schema *values* into a client: requiredString is
// z.unknown().transform(...), so a client-side parse coerces a non-string to '' instead of
// rejecting it, silently changing the bytes on the wire.

type Prettify<T> = { [K in keyof T]: T[K] } & {}

/** zod's own input-side key-optionality rule, copied from $InferObjectInput. */
type SendOptionalSchema = { _zod: { optin: 'optional' | 'defaulted' } }

type SendShape<Shape> = Prettify<
  {
    -readonly [K in keyof Shape as Shape[K] extends SendOptionalSchema ? never : K]: RpcSendInput<
      Shape[K]
    >
  } & {
    -readonly [K in keyof Shape as Shape[K] extends SendOptionalSchema ? K : never]?: RpcSendInput<
      Shape[K]
    >
  }
>

/**
 * The value a sender may put on the wire for one schema. Wrappers not listed here (record,
 * tuple, lazy, intersection) fall through to z.output, which is what shipped before.
 */
export type RpcSendInput<Schema> =
  Schema extends z.ZodOptional<infer Inner>
    ? RpcSendInput<Inner> | undefined
    : Schema extends z.ZodDefault<infer Inner>
      ? RpcSendInput<Inner> | undefined
      : Schema extends z.ZodPrefault<infer Inner>
        ? RpcSendInput<Inner> | undefined
        : Schema extends z.ZodNullable<infer Inner>
          ? RpcSendInput<Inner> | null
          : Schema extends z.ZodArray<infer Element>
            ? RpcSendInput<Element>[]
            : // ZodObject is the only schema carrying a `shape`, and matching on it keeps
              // .strict()/.extend()/.superRefine() results in this branch.
              Schema extends { shape: infer Shape }
              ? keyof Shape extends never
                ? // Mirrors $InferObjectOutput: a no-field object admits no properties.
                  Record<string, never>
                : SendShape<Shape>
              : // ZodDiscriminatedUnion extends ZodUnion, so both land here.
                Schema extends z.ZodUnion<infer Options>
                ? RpcSendInput<Options[number]>
                : Schema extends z.ZodType
                  ? z.output<Schema>
                  : never

/** The params a client may send for `Method`; `void` for the methods that take none. */
export type RpcSendParams<Method extends RpcMethodName> =
  (typeof RPC_PARAMS_BY_METHOD)[Method] extends z.ZodType
    ? RpcSendInput<(typeof RPC_PARAMS_BY_METHOD)[Method]>
    : void
