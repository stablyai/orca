/**
 * The delivery boundary a sender asks for, orthogonal to a message's `type` and `priority`:
 *
 * - `interrupt` — surface as soon as possible, even mid-task;
 * - `tool` — surface at the recipient's next action boundary;
 * - `turn` — surface when the recipient finishes its current turn.
 *
 * Orca stores and returns the class. Deciding what to do with it belongs to whatever supervises
 * the recipient agent, which is why `turn` is the default: it is the boundary a message already
 * lands at when the recipient polls `orchestration check` on its own.
 */
export const MESSAGE_DELIVERY_CLASSES = ['interrupt', 'tool', 'turn'] as const

export type MessageDeliveryClass = (typeof MESSAGE_DELIVERY_CLASSES)[number]

export const DEFAULT_MESSAGE_DELIVERY_CLASS: MessageDeliveryClass = 'turn'

export function isMessageDeliveryClass(value: unknown): value is MessageDeliveryClass {
  return (MESSAGE_DELIVERY_CLASSES as readonly unknown[]).includes(value)
}
