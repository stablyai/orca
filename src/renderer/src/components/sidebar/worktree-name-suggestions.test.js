import { describe, expect, it } from 'vitest';
import { sanitizeWorktreeName } from '../../../../main/ipc/worktree-logic';
import { MARINE_CREATURES } from '@/constants/marine-creatures';
import { getSuggestedCreatureName, normalizeSuggestedName, shouldApplySuggestedName } from './worktree-name-suggestions';
describe('getSuggestedCreatureName', () => {
    it('returns the first creature name when no repo is selected', () => {
        expect(getSuggestedCreatureName('', {}, false)).toBe(MARINE_CREATURES[0]);
    });
    it('skips names already used in the selected repo', () => {
        expect(getSuggestedCreatureName('repo-1', {
            'repo-1': [{ path: '/tmp/worktrees/Nautilus' }, { path: '/tmp/worktrees/Seahorse' }]
        }, true)).toBe('Starfish');
    });
    it('checks all repos when nestWorkspaces is false', () => {
        expect(getSuggestedCreatureName('repo-1', {
            'repo-1': [],
            'repo-2': [{ path: '/tmp/worktrees/Nautilus' }]
        }, false)).toBe('Seahorse');
    });
    it('only checks the selected repo when nestWorkspaces is true', () => {
        expect(getSuggestedCreatureName('repo-1', {
            'repo-1': [],
            'repo-2': [{ path: '/tmp/worktrees/Nautilus' }]
        }, true)).toBe('Nautilus');
    });
    it('falls back to suffixed variants after the base list is exhausted', () => {
        const usedWorktrees = MARINE_CREATURES.map((name) => ({ path: `/tmp/worktrees/${name}` }));
        expect(getSuggestedCreatureName('repo-1', {
            'repo-1': usedWorktrees
        }, true)).toBe(`${MARINE_CREATURES[0]}-2`);
    });
    it('treats used names case-insensitively', () => {
        expect(getSuggestedCreatureName('repo-1', {
            'repo-1': [{ path: '/tmp/worktrees/nAuTiLuS' }]
        }, true)).toBe('Seahorse');
    });
    it('handles Windows-style worktree paths when deriving used basenames', () => {
        expect(getSuggestedCreatureName('repo-1', {
            'repo-1': [{ path: 'C:\\worktrees\\Nautilus' }]
        }, true)).toBe('Seahorse');
    });
    it('handles stored worktree paths with trailing separators', () => {
        expect(getSuggestedCreatureName('repo-1', {
            'repo-1': [{ path: 'C:\\worktrees\\Nautilus\\\\' }, { path: '/tmp/worktrees/Seahorse///' }]
        }, true)).toBe('Starfish');
    });
});
describe('shouldApplySuggestedName', () => {
    it('applies a suggestion when the field is blank', () => {
        expect(shouldApplySuggestedName('', 'Nautilus')).toBe(true);
        expect(shouldApplySuggestedName('   ', 'Nautilus')).toBe(true);
    });
    it('applies a recomputed suggestion when the current value is still the prior suggestion', () => {
        expect(shouldApplySuggestedName('Nautilus', 'Nautilus')).toBe(true);
    });
    it('does not overwrite a user-edited custom name when the repo selection changes', () => {
        expect(shouldApplySuggestedName('feature/custom-branch', 'Nautilus')).toBe(false);
    });
});
describe('MARINE_CREATURES', () => {
    it('is non-empty and unique after normalization and sanitization', () => {
        expect(MARINE_CREATURES.length).toBeGreaterThanOrEqual(260);
        const normalizedNames = MARINE_CREATURES.map(normalizeSuggestedName);
        const sanitizedNames = MARINE_CREATURES.map((name) => sanitizeWorktreeName(name));
        expect(new Set(normalizedNames).size).toBe(MARINE_CREATURES.length);
        expect(new Set(sanitizedNames).size).toBe(MARINE_CREATURES.length);
    });
    it('avoids names that read poorly as UI defaults', () => {
        const disallowedNames = [
            'Crappie',
            'Sucker',
            'Spadefish',
            'Lumpsucker',
            'Hogchoker',
            'Hogsucker',
            'Mudsucker',
            'Hardhead'
        ];
        for (const disallowedName of disallowedNames) {
            expect(MARINE_CREATURES).not.toContain(disallowedName);
        }
    });
});
