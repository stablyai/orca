import { useEffect, useState } from 'react'

const EVENT = 'orca:git-blame-preference'

function key(worktreeId: string): string {
	return `orca:git-blame:${worktreeId}`
}

export function readGitBlamePreference(worktreeId: string): boolean {
	return localStorage.getItem(key(worktreeId)) !== 'false'
}

export function useGitBlamePreference(worktreeId: string): [boolean, (enabled: boolean) => void] {
	const [enabled, setEnabledState] = useState(() => readGitBlamePreference(worktreeId))
	useEffect(() => {
		setEnabledState(readGitBlamePreference(worktreeId))
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
		localStorage.setItem(key(worktreeId), String(next))
		window.dispatchEvent(new CustomEvent(EVENT, { detail: { worktreeId, enabled: next } }))
	}
	return [enabled, setEnabled]
}
