/**
 * Outcome of recording a command's retry receipt inside the transaction that commits its effect.
 * Same id with the same input is a duplicate (answer from `existing`); different input is a conflict.
 * A store that can hold rows it cannot parse reports them as unreadable, never as absent.
 */
export type CommandReceiptInsert<Existing, Unreadable = never> =
  | { inserted: true }
  | { inserted: false; reason: 'duplicate' | 'conflict'; existing: Existing }
  | ([Unreadable] extends [never]
      ? never
      : { inserted: false; reason: 'unreadable'; existing: Unreadable })
