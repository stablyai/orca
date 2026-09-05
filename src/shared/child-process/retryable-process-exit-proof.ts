export class RetryableProcessExitProof {
  private inFlight: Promise<boolean> | null = null

  run(proveExit: () => Promise<boolean>): Promise<boolean> {
    if (this.inFlight) {
      return this.inFlight
    }
    const attempt = proveExit()
    this.inFlight = attempt
    void attempt.then(
      (proven) => {
        if (!proven) {
          this.clear(attempt)
        }
      },
      () => this.clear(attempt)
    )
    return attempt
  }

  private clear(attempt: Promise<boolean>): void {
    if (this.inFlight === attempt) {
      this.inFlight = null
    }
  }
}
