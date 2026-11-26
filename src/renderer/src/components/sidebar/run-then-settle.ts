/** Runs work, then settle even if it throws; outside components because React Compiler can't compile try/finally. */
export async function runThenSettle<T>(work: () => Promise<T>, settle: () => void): Promise<T> {
  try {
    return await work()
  } finally {
    settle()
  }
}
