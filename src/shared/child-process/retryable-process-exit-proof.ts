export class RetryableProcessExitProof<Result> {
  private inFlight: Promise<Result> | null = null

  constructor(private readonly isProven: (result: Result) => boolean) {}

  run(proveExit: () => Promise<Result>): Promise<Result> {
    if (this.inFlight) {
      return this.inFlight
    }
    const attempt = proveExit()
    this.inFlight = attempt
    void attempt.then(
      (result) => {
        if (!this.isProven(result)) {
          this.clear(attempt)
        }
      },
      () => this.clear(attempt)
    )
    return attempt
  }

  private clear(attempt: Promise<Result>): void {
    if (this.inFlight === attempt) {
      this.inFlight = null
    }
  }
}
