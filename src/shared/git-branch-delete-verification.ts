export class BranchDeletionUnverifiedError extends Error {
  constructor(branchName: string, cause: unknown) {
    super(
      `Could not verify or restore branch "${branchName}" after deletion. Review the repository before continuing.`,
      { cause }
    )
    this.name = 'BranchDeletionUnverifiedError'
  }
}

export async function verifyDeletedBranchCheckout(
  branchName: string,
  isCheckedOut: () => Promise<boolean>,
  restoreExpectedHead: () => Promise<unknown>
): Promise<void> {
  try {
    if (await isCheckedOut()) {
      throw new Error(`Local branch "${branchName}" is checked out in another worktree.`)
    }
  } catch (error) {
    // A failed checkout scan is no evidence that the deleted ref is safe to leave absent.
    try {
      await restoreExpectedHead()
    } catch (cause) {
      throw new BranchDeletionUnverifiedError(branchName, cause)
    }
    throw error
  }
}
