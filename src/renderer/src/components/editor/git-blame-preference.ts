import { useEffect, useState } from 'react'

const EVENT = 'orca:git-blame-preference'

function key(worktreeId: string): string {
	return `orca:git-blame:${worktreeId}`
}

export function readGitBlamePreference(worktreeId: string): boolean {
	try {
		return globalThis.localStorage?.getItem(key(worktreeId)) !== 'false'
	} catch {
		return true
	}
}

export function writeGitBlamePreference(worktreeId: string, enabled: boolean): void {
	try {
		globalThis.localStorage?.setItem(key(worktreeId), String(enabled))
	} catch {
		// Storage can be denied without disabling blame for the current session.
	}
}

export function useGitBlamePreference(worktreeId: string): [boolean, (enabled: boolean) => void] {
	const [enabled, setEnabledState] = useState(() => readGitBlamePreference(worktreeId))
	useEffect(() => {
		setEnabledState(readGitBlamePreference(worktreeId))
		if (typeof window === 'undefined') {
			return
		}
		const listener = (event: Event): void => {
			const detail = (event as CustomEvent<{ worktreeId: string; enabled: boolean }>).detail
			if (detail.worktreeId === worktreeId) {
				setEnabledState(detail.enabled)
			}
		}
		window.addEventListener(EVENT, listener)
		return () => window.removeEventListener(EVENT, listener)
	}, [worktreeId])
	const setEnabled = (next: boolean): void => {
		setEnabledState(next)
		writeGitBlamePreference(worktreeId, next)
		if (typeof window !== 'undefined') {
			window.dispatchEvent(new CustomEvent(EVENT, { detail: { worktreeId, enabled: next } }))
		}
	}
	return [enabled, setEnabled]
}
