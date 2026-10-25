import type { z } from 'zod'
import type { RPC_PARAMS_BY_METHOD, RpcMethodName } from './rpc-params-catalog.generated'

// Derive sender optionality from Zod’s optin marker and values from z.output: defaults are optional on the wire,
// while z.input becomes unknown for our coercing builders. Keep schema imports type-only; client-side parsing
// would coerce values and silently rewrite wire bytes.

type Prettify<T> = { [K in keyof T]: T[K] } & {}

/** zod's own input-side key-optionality rule, copied from $InferObjectInput. */
type SendOptionalSchema = { _zod: { optin: 'optional' | 'defaulted' } }

type SendFields<Fields> = Prettify<
  {
    -readonly [K in keyof Fields as Fields[K] extends SendOptionalSchema ? never : K]: RpcSendInput<
      Fields[K]
    >
  } & {
    -readonly [
      K in keyof Fields as Fields[K] extends SendOptionalSchema ? K : never
    ]?: RpcSendInput<Fields[K]>
  }
>

/** Unlisted wrappers (record/tuple/lazy/intersection) retain the shipped z.output fallback. */
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
            : // Match shape to include strict/extend/superRefine object variants.
              Schema extends { shape: infer Fields }
              ? keyof Fields extends never
                ? // Mirrors $InferObjectOutput: a no-field object admits no properties.
                  Record<string, never>
                : SendFields<Fields>
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
