/** Returns `compute()`. `_inputs` are values a memo must recompute for although `compute` never
 *  reads them: React Compiler keys memos on what a call receives, and drops a bare `void x`. */
export function recomputeOn<T>(_inputs: readonly unknown[], compute: () => T): T {
  return compute()
}
