import { useCallback, useLayoutEffect, useMemo, useReducer, useRef } from 'react'
import type { LinearReadScope } from '@/store/slices/linear/linear-slice-scope'
import type {
  LinearIssueLease,
  LinearIssueView
} from '@/store/slices/linear/linear-issue-publication'

type Receipt<T> = {
  target: string
  live: () => boolean
  current: (field?: string) => boolean
  matches?: (previous: T) => boolean
  fields?: readonly string[]
  apply: (previous: T, fields?: readonly string[]) => T
  acknowledge?: () => void
}
type Saved<T> = {
  target: string
  value: T
  whole: Receipt<T> | null
  origins: Record<string, Receipt<T>>
}
type Committed<T> = { target: string; saved: Saved<T>; live: boolean }

// React may replay an action after its read retires; only its current committed contribution survives.
export function useLinearCommittedState<T>(
  target: string,
  seed: T,
  scope: LinearReadScope,
  projectSeed?: (previous: { target: string; value: T }) => T
) {
  const committed = useRef<Committed<T> | null>(null)
  const snapshot = committed.current
  const deliveredSeed =
    snapshot?.live &&
    snapshot.saved.target === snapshot.target &&
    snapshot.target !== target &&
    scope.isCurrentRuntime() &&
    projectSeed
      ? projectSeed(snapshot.saved)
      : seed
  // oxlint-disable-next-line react-hooks/exhaustive-deps -- Why: this lifetime is renewed only by the complete semantic target.
  const lifetime = useMemo(() => ({ live: false }), [target])
  const [saved, dispatch] = useReducer(
    (previous: Saved<T>, action: Receipt<T>): Saved<T> => {
      const snapshot = committed.current
      if (!snapshot?.live || snapshot.target !== action.target || !action.live()) {
        return previous
      }
      const reconstructWhole = snapshot.saved.whole === action
      if (action.fields) {
        if (
          previous.target !== action.target ||
          (action.matches && !action.matches(previous.value))
        ) {
          return previous
        }
        const fields = action.fields.filter(
          (field) => snapshot.saved.origins[field] === action || action.current(field)
        )
        if (!fields.length) {
          return previous
        }
        const origins = { ...previous.origins }
        for (const field of fields) {
          origins[field] = action
        }
        return { ...previous, value: action.apply(previous.value, fields), origins }
      }
      if (
        !reconstructWhole &&
        (!action.current() || (action.matches && !action.matches(previous.value)))
      ) {
        return previous
      }
      return {
        target: action.target,
        value: action.apply(previous.value),
        whole: action,
        origins: {}
      }
    },
    { target, value: deliveredSeed, whole: null, origins: {} }
  )

  useLayoutEffect(() => {
    lifetime.live = true
    return () => {
      lifetime.live = false
      if (committed.current?.target === target) {
        committed.current.live = false
      }
    }
  }, [lifetime, target])
  useLayoutEffect(() => {
    committed.current = { target, saved, live: true }
    if (saved.target === target) {
      saved.whole?.acknowledge?.()
    }
  })
  const isCurrent = useCallback(
    () => lifetime.live && committed.current?.target === target && scope.isCurrentRuntime(),
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- Why: target includes the complete source/runtime identity.
    [lifetime, target]
  )
  const publish = useCallback(
    (
      apply: Receipt<T>['apply'],
      current: Receipt<T>['current'] = () => true,
      options: Pick<Receipt<T>, 'fields' | 'matches' | 'acknowledge'> = {}
    ) => {
      dispatch({ target, live: isCurrent, current, apply, ...options })
    },
    [isCurrent, target]
  )
  useLayoutEffect(() => {
    if (saved.target !== target) {
      publish(() => deliveredSeed)
    }
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- Why: a real target change resets its seed, field edits do not.
  }, [target, publish])
  const read = useCallback(
    <D>(
      lease: LinearIssueLease<D>,
      view: LinearIssueView<D>,
      apply: (previous: T, data: D | null, fields?: readonly string[]) => T,
      options?: Pick<Receipt<T>, 'fields' | 'matches' | 'acknowledge'>
    ) =>
      publish(
        (previous, fields) => apply(previous, view.data, fields),
        () => lease.commit(view, false, () => true),
        options
      ),
    [publish]
  )
  const value = saved.target === target ? saved.value : deliveredSeed
  return { value, publish, read, isCurrent, committed }
}

type IssueResult<T> = {
  data: T
  loading: boolean
  error: string | null
  hasMore: boolean
  settledUrl: string | null
}
export function useLinearIssueResult<T extends object | null>(
  target: string,
  data: T,
  scope: LinearReadScope,
  projectDataSeed?: (data: T, previousTarget: string) => T
) {
  const saved = useLinearCommittedState<IssueResult<T>>(
    target,
    { data, loading: false, error: null, hasMore: false, settledUrl: null },
    scope,
    projectDataSeed &&
      ((previous) => ({
        data: projectDataSeed(previous.value.data, previous.target),
        loading: false,
        error: null,
        hasMore: false,
        settledUrl: null
      }))
  )
  const { publish, read: consumeRead } = saved
  const setData = useCallback(
    (data: T) =>
      publish(
        (previous) => ({ ...previous, data }),
        () => true,
        { fields: ['data'] }
      ),
    [publish]
  )
  const setLoading = useCallback(
    (update: React.SetStateAction<boolean>) =>
      publish(
        (previous) => ({
          ...previous,
          loading: typeof update === 'function' ? update(previous.loading) : update
        }),
        () => true,
        { fields: ['loading'] }
      ),
    [publish]
  )
  const setError = useCallback(
    (update: React.SetStateAction<string | null>) =>
      publish(
        (previous) => ({
          ...previous,
          error: typeof update === 'function' ? update(previous.error) : update
        }),
        () => true,
        { fields: ['error'] }
      ),
    [publish]
  )
  const setHasMore = useCallback(
    (update: React.SetStateAction<boolean>) =>
      publish(
        (previous) => ({
          ...previous,
          hasMore: typeof update === 'function' ? update(previous.hasMore) : update
        }),
        () => true,
        { fields: ['hasMore'] }
      ),
    [publish]
  )
  const setSettledUrl = useCallback(
    (update: React.SetStateAction<string | null>) =>
      publish(
        (previous) => ({
          ...previous,
          settledUrl: typeof update === 'function' ? update(previous.settledUrl) : update
        }),
        () => true,
        { fields: ['settledUrl'] }
      ),
    [publish]
  )
  const read = useCallback(
    <D>(lease: LinearIssueLease<D>, view: LinearIssueView<D>, result: Partial<IssueResult<T>>) => {
      consumeRead(
        lease,
        view,
        (previous, _data, fields) =>
          Object.assign(
            {},
            previous,
            Object.fromEntries(Object.entries(result).filter(([key]) => fields?.includes(key)))
          ),
        {
          fields: Object.keys(result)
        }
      )
    },
    [consumeRead]
  )
  return {
    ...saved.value,
    read,
    setData,
    setLoading,
    setError,
    setHasMore,
    setSettledUrl,
    isCurrent: saved.isCurrent
  }
}
