export type DiffCommentComposerSnapshot = Readonly<{
  body: string
  phase: 'editing' | 'submitting' | 'saved' | 'canceled'
}>

export type DiffCommentCreate = (comment: {
  lineNumber: number
  startLine?: number
  body: string
}) => Promise<boolean>

export class DiffCommentComposerSession {
  private snapshot: DiffCommentComposerSnapshot
  private attempt: symbol | null = null
  private readonly listeners = new Set<() => void>()

  constructor(body: string) {
    this.snapshot = { body, phase: 'editing' }
  }

  getSnapshot = (): DiffCommentComposerSnapshot => this.snapshot
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  setBody(body: string): void {
    if (this.live && body !== this.snapshot.body) {
      this.publish({ ...this.snapshot, body })
    }
  }

  get live(): boolean {
    return this.snapshot.phase === 'editing' || this.snapshot.phase === 'submitting'
  }

  cancel(): void {
    if (this.snapshot.phase !== 'canceled') {
      this.attempt = null
      this.publish({ body: '', phase: 'canceled' })
    }
  }

  dispose(): void {
    this.cancel()
    this.listeners.clear()
  }

  private publish(snapshot: DiffCommentComposerSnapshot): void {
    this.snapshot = snapshot
    for (const listener of this.listeners) {
      listener()
    }
  }

  submit(action: ((body: string) => Promise<boolean>) | null, body: string): Promise<boolean> {
    if (!action || this.snapshot.phase !== 'editing') {
      return Promise.resolve(false)
    }
    const attempt = Symbol()
    const submittedBody = this.snapshot.body
    this.attempt = attempt
    this.publish({ body: submittedBody, phase: 'submitting' })
    if (this.attempt !== attempt) {
      return Promise.resolve(false)
    }
    let request: Promise<boolean>
    try {
      request = action(body)
    } catch (error) {
      request = Promise.reject(error)
    }
    return this.settle(request, attempt, submittedBody)
  }

  private async settle(
    request: Promise<boolean>,
    attempt: symbol,
    submittedBody: string
  ): Promise<boolean> {
    let saved = false
    try {
      saved = await request
      return saved
    } finally {
      if (this.attempt === attempt) {
        this.attempt = null
        this.publish({
          body: this.snapshot.body,
          phase: saved && this.snapshot.body === submittedBody ? 'saved' : 'editing'
        })
      }
    }
  }
}

export class DiffCommentDraftSession extends DiffCommentComposerSession {
  constructor(
    readonly target: { lineNumber: number; startLine?: number },
    body: string,
    public createComment: DiffCommentCreate | undefined
  ) {
    super(body)
  }

  override cancel(): void {
    this.createComment = undefined
    super.cancel()
  }
}

export class DiffCommentFileSession {
  private readonly edits = new Map<string, DiffCommentComposerSession>()
  private readonly editListeners = new Map<string, Set<() => void>>()
  private readonly draftListeners = new Set<() => void>()
  private draft: DiffCommentDraftSession | null = null
  private disposed = false
  private pending = 0
  private readonly attempts = new Set<DiffCommentDraftSession>()

  constructor(
    private readonly activate: () => boolean = () => true,
    private readonly idle: () => void = () => {}
  ) {}

  getEdit(id: string): DiffCommentComposerSession | null {
    return this.edits.get(id) ?? null
  }

  subscribeEdit(id: string, listener: () => void): () => void {
    let listeners = this.editListeners.get(id)
    if (!listeners) {
      listeners = new Set()
      this.editListeners.set(id, listeners)
    }
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
      if (!listeners.size) {
        this.editListeners.delete(id)
      }
    }
  }

  private editChanged(id: string): void {
    for (const listener of this.editListeners.get(id) ?? []) {
      listener()
    }
    this.idle()
  }

  startEdit(id: string, body: string): void {
    if (this.disposed || !this.activate()) {
      return
    }
    const previous = this.edits.get(id)
    this.edits.set(id, new DiffCommentComposerSession(body))
    previous?.cancel()
    this.editChanged(id)
  }

  cancelEdit(id: string, expected: DiffCommentComposerSession): void {
    if (this.edits.get(id) !== expected) {
      return
    }
    this.edits.delete(id)
    expected.cancel()
    this.editChanged(id)
  }

  submitEdit(
    id: string,
    expected: DiffCommentComposerSession,
    action: (body: string) => Promise<boolean>,
    body: string
  ): Promise<boolean> {
    if (
      this.disposed ||
      this.edits.get(id) !== expected ||
      expected.getSnapshot().phase !== 'editing'
    ) {
      return Promise.resolve(false)
    }
    this.pending++
    return this.settleEdit(id, expected, expected.submit(action, body))
  }

  private async settleEdit(
    id: string,
    expected: DiffCommentComposerSession,
    request: Promise<boolean>
  ): Promise<boolean> {
    try {
      return await request
    } finally {
      this.pending--
      if (this.edits.get(id) === expected && expected.getSnapshot().phase === 'saved') {
        this.edits.delete(id)
        this.editChanged(id)
      }
      this.idle()
    }
  }

  getDraft = (): DiffCommentDraftSession | null => this.draft
  subscribeDraft = (listener: () => void): (() => void) => {
    this.draftListeners.add(listener)
    return () => this.draftListeners.delete(listener)
  }

  private draftChanged(): void {
    for (const listener of this.draftListeners) {
      listener()
    }
    this.idle()
  }

  openDraft(
    target: DiffCommentDraftSession['target'],
    createComment?: DiffCommentCreate
  ): DiffCommentDraftSession | null {
    if (this.disposed || !this.activate()) {
      return null
    }
    const previous = this.draft
    const submitting = previous?.getSnapshot().phase === 'submitting'
    this.draft = new DiffCommentDraftSession(
      target,
      submitting ? '' : (previous?.getSnapshot().body ?? ''),
      submitting ? createComment : (previous?.createComment ?? createComment)
    )
    if (!submitting) {
      previous?.cancel()
    }
    this.draftChanged()
    return this.draft
  }

  cancelDraft(expected: DiffCommentDraftSession): void {
    if (this.draft !== expected) {
      return
    }
    this.draft = null
    expected.cancel()
    this.draftChanged()
  }

  submitDraft(
    expected: DiffCommentDraftSession,
    action: DiffCommentCreate,
    body: string
  ): Promise<boolean> {
    if (this.disposed || this.draft !== expected || expected.getSnapshot().phase !== 'editing') {
      return Promise.resolve(false)
    }
    this.pending++
    this.attempts.add(expected)
    const request = expected.submit((value) => action({ ...expected.target, body: value }), body)
    return this.settleDraft(expected, request)
  }

  private async settleDraft(
    expected: DiffCommentDraftSession,
    request: Promise<boolean>
  ): Promise<boolean> {
    let saved = false
    try {
      saved = await request
      return saved
    } finally {
      this.pending--
      this.attempts.delete(expected)
      if (!this.disposed && expected.getSnapshot().phase !== 'canceled') {
        if (saved && expected.getSnapshot().phase === 'saved') {
          if (this.draft === expected) {
            this.draft = null
            expected.createComment = undefined
            this.draftChanged()
          }
        } else if (!this.draft) {
          this.draft = expected
          this.draftChanged()
        }
      }
      if (this.draft !== expected) {
        expected.cancel()
      }
      this.idle()
    }
  }

  pruneEdits(ids: ReadonlySet<string>): void {
    for (const [id, session] of this.edits) {
      if (!ids.has(id)) {
        this.cancelEdit(id, session)
      }
    }
  }

  get hasWork(): boolean {
    return this.edits.size > 0 || this.draft !== null || this.pending > 0
  }

  dispose(): void {
    if (this.disposed) {
      return
    }
    this.disposed = true
    for (const attempt of this.attempts) {
      attempt.dispose()
    }
    this.attempts.clear()
    for (const [id, session] of this.edits) {
      this.cancelEdit(id, session)
      session.dispose()
    }
    if (this.draft) {
      const draft = this.draft
      this.cancelDraft(draft)
      draft.dispose()
    }
    this.editListeners.clear()
    this.draftListeners.clear()
  }
}
