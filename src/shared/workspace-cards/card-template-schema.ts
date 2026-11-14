import { z } from 'zod'
import { WORKSPACE_CARD_FACTS_VERSION } from './workspace-card-facts'

/** Template format major; additive changes keep 1. */
export const CARD_TEMPLATE_VERSION = 1

export const CARD_TEMPLATE_LIMITS = {
  maxBytes: 64 * 1024,
  maxNodes: 400,
  /** Elements after every def reference is inlined; reuse multiplies, so this bounds render work. */
  maxExpandedNodes: 2000,
  maxDepth: 24,
  /** Defs referenced inside defs, counted along one expansion chain. */
  maxDefDepth: 8,
  maxVars: 100,
  maxPropsPerNode: 32,
  maxStringLength: 1024
} as const

/** A string starting with `=` is an expression over facts; anything else is a literal. */
export const CARD_EXPRESSION_PREFIX = '='

const elementName = z
  .string()
  .regex(/^[A-Z][A-Za-z0-9]{0,63}$/, 'must be a PascalCase element name')
const identifier = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/, 'must be an identifier')
const expression = z.string().min(1).max(CARD_TEMPLATE_LIMITS.maxStringLength)
const propValue = z.union([
  z.string().max(CARD_TEMPLATE_LIMITS.maxStringLength),
  z.number().finite(),
  z.boolean(),
  z.null()
])

export type CardPropValue = z.infer<typeof propValue>

export type CardTemplateNode = {
  el: string
  when?: string
  props?: Record<string, CardPropValue>
  children?: CardTemplateNode[]
}

export const cardTemplateNodeSchema: z.ZodType<CardTemplateNode> = z.lazy(() =>
  z
    .object({
      el: elementName,
      when: expression.optional(),
      props: z
        .record(identifier, propValue)
        .refine(
          (props) => Object.keys(props).length <= CARD_TEMPLATE_LIMITS.maxPropsPerNode,
          `at most ${CARD_TEMPLATE_LIMITS.maxPropsPerNode} props`
        )
        .optional(),
      children: z.array(cardTemplateNodeSchema).optional()
    })
    .strict()
)

export const cardTemplateSchema = z
  .object({
    version: z.literal(CARD_TEMPLATE_VERSION),
    /** Fact model major the template reads. */
    facts: z.literal(WORKSPACE_CARD_FACTS_VERSION),
    /** Named expressions, evaluated in order; each may read earlier ones as `vars.<name>`. */
    vars: z
      .record(identifier, expression)
      .refine(
        (vars) => Object.keys(vars).length <= CARD_TEMPLATE_LIMITS.maxVars,
        `at most ${CARD_TEMPLATE_LIMITS.maxVars} vars`
      )
      .optional(),
    /** Named subtrees an element can use by name. */
    defs: z.record(elementName, cardTemplateNodeSchema).optional(),
    /** What Orca's card frame needs from the template. */
    frame: z
      .object({
        /** Tighter vertical padding for a card that is a single line. */
        singleLine: propValue.optional(),
        /** The card leads with a status lane, which nested indentation aligns to. */
        statusLane: propValue.optional()
      })
      .strict()
      .optional(),
    root: cardTemplateNodeSchema
  })
  .strict()
  .superRefine((template, ctx) => {
    let nodes = 0
    const visit = (node: CardTemplateNode, depth: number): void => {
      nodes++
      if (depth > CARD_TEMPLATE_LIMITS.maxDepth) {
        ctx.addIssue({
          code: 'custom',
          message: `nested deeper than ${CARD_TEMPLATE_LIMITS.maxDepth}`
        })
        return
      }
      for (const child of node.children ?? []) {
        visit(child, depth + 1)
      }
    }
    visit(template.root, 1)
    for (const def of Object.values(template.defs ?? {})) {
      visit(def, 1)
    }
    if (nodes > CARD_TEMPLATE_LIMITS.maxNodes) {
      ctx.addIssue({ code: 'custom', message: `more than ${CARD_TEMPLATE_LIMITS.maxNodes} nodes` })
    }
  })

export type CardTemplate = z.infer<typeof cardTemplateSchema>

export function isCardExpression(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith(CARD_EXPRESSION_PREFIX)
}
