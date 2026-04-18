/**
 * Reconcile stored tab bar order with the current set of tab IDs.
 * Keeps items that still exist in their stored positions, appends new items
 * at the end in their natural order (not grouped by type).
 */
export declare function reconcileTabOrder(storedOrder: string[] | undefined, terminalIds: string[], editorIds: string[], browserIds?: string[]): string[];
